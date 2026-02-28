import * as vscode from "vscode";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type FromWebview =
  | { type: "send"; text: string }
  | { type: "start" }
  | { type: "stop" }
  | { type: "newSession" }
  | { type: "switchSession"; session: string }
  | { type: "pickFileCommand" }
  | { type: "insertGuide" }
  | { type: "refreshMeta" }
  | { type: "usePrompt"; name: string }
  | { type: "useModel"; name: string }
  | { type: "addModel"; name: string; baseUrl?: string; apiKeyEnv?: string; apiKey?: string };

type ToWebview =
  | { type: "assistantChunk"; text: string }
  | { type: "status"; text: string; level: "info" | "warn" | "error" }
  | { type: "running"; value: boolean }
  | { type: "clearAssistantBuffer" }
  | { type: "sessions"; sessions: string[]; active: string }
  | { type: "insertInput"; text: string; append: boolean }
  | { type: "metaState"; prompts: string[]; activePrompt: string; models: string[]; activeModel: string }
  | { type: "hydrateHistory"; messages: Array<{ role: string; content: string }> };

class DongshanChatProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "dongshanChatView";

  private view?: vscode.WebviewView;
  private proc?: ChildProcessWithoutNullStreams;
  private sessionName = "";
  private sessions: string[] = [];
  private pendingAssistantChunk = false;
  private execConfirmBuffer = "";
  private execConfirmQueue: Array<{ command: string; prefix: string }> = [];
  private execConfirmInFlight = false;
  private restartAfterStop = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.bootstrapSessions();
    this.view = view;
    view.webview.options = {
      enableScripts: true
    };
    view.webview.html = this.getHtml(view.webview);
    this.pushSessions();
    this.pushSessionHistory(this.sessionName);

    view.webview.onDidReceiveMessage((msg: FromWebview) => {
      switch (msg.type) {
        case "send":
          this.sendToProcess(msg.text);
          break;
        case "start":
          this.startProcess();
          break;
        case "stop":
          this.stopProcess();
          break;
        case "newSession":
          this.newSession();
          break;
        case "switchSession":
          this.switchSession(msg.session);
          break;
        case "pickFileCommand":
          void this.pickAndInsertFileCommand();
          break;
        case "insertGuide":
          this.insertIntoInput(buildCommandGuide(), false);
          break;
        case "refreshMeta":
          void this.refreshModelAndPromptState(true);
          break;
        case "usePrompt":
          void this.usePrompt(msg.name);
          break;
        case "useModel":
          void this.useModel(msg.name);
          break;
        case "addModel":
          void this.addModel(msg);
          break;
      }
    });

    if (this.cfg().get<boolean>("autoStart", true)) {
      this.startProcess();
    } else {
      this.post({ type: "status", text: "Ready. Click Start to launch dongshan chat.", level: "info" });
    }
    void this.refreshModelAndPromptState(false);
  }

  dispose(): void {
    this.stopProcess();
  }

  sendSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage("No active editor.");
      return;
    }
    const selection = editor.selection.isEmpty ? editor.document.getText() : editor.document.getText(editor.selection);
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
    const payload = `璇峰垎鏋愯繖涓枃浠剁墖娈靛苟缁欏缓璁細\nFile: ${relativePath}\n\`\`\`\n${selection}\n\`\`\``;
    this.sendToProcess(payload);
  }

  insertCommandForUri(kind: "read" | "askfile" | "grep", uri?: vscode.Uri): void {
    const cmd = this.buildCommandFromUri(kind, uri);
    if (!cmd) {
      return;
    }
    void vscode.commands.executeCommand("workbench.view.extension.dongshan");
    this.insertIntoInput(cmd, false);
  }

  insertIntoInput(text: string, append = true): void {
    if (!text.trim()) {
      return;
    }
    this.post({ type: "insertInput", text, append });
  }

  startProcess(): void {
    if (this.proc && !this.proc.killed) {
      this.post({ type: "status", text: "dongshan chat is already running.", level: "info" });
      this.post({ type: "running", value: true });
      return;
    }

    const config = this.cfg();
    const cmd = config.get<string>("executable", "dongshan");
    const extraArgs = config.get<string[]>("extraArgs", []);
    const args = ["chat", "--session", this.sessionName, ...extraArgs];
    const cwd = this.workspaceFolderPath() ?? process.cwd();

    this.post({ type: "status", text: `Starting: ${cmd} ${args.join(" ")}`, level: "info" });
    this.post({ type: "clearAssistantBuffer" });
    this.execConfirmBuffer = "";
    this.execConfirmQueue = [];
    this.execConfirmInFlight = false;

    try {
      this.proc = spawn(cmd, args, { cwd, stdio: "pipe", shell: true });
    } catch (err) {
      this.post({
        type: "status",
        text: `Failed to start dongshan: ${err instanceof Error ? err.message : String(err)}`,
        level: "error"
      });
      return;
    }

    this.post({ type: "running", value: true });

    this.proc.stdout.on("data", (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString("utf8")).replace(/\r/g, "");
      this.handleProcessStdout(text);
    });

    this.proc.stderr.on("data", (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString("utf8")).replace(/\r/g, "");
      this.post({ type: "status", text: text.trim(), level: "warn" });
    });

    this.proc.on("close", (code, signal) => {
      this.proc = undefined;
      this.post({
        type: "status",
        text: `dongshan chat stopped (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        level: code === 0 || code === null ? "info" : "warn"
      });
      this.post({ type: "running", value: false });
      this.pendingAssistantChunk = false;
      if (this.restartAfterStop) {
        this.restartAfterStop = false;
        setTimeout(() => this.startProcess(), 50);
      }
    });

    this.proc.on("error", (err) => {
      this.post({ type: "status", text: `Process error: ${err.message}`, level: "error" });
      this.post({ type: "running", value: false });
    });
  }

  stopProcess(): void {
    if (!this.proc) {
      return;
    }
    this.sendRaw("/exit");
    setTimeout(() => {
      if (this.proc && !this.proc.killed) {
        this.proc.kill();
      }
    }, 300);
  }

  newSession(): void {
    this.sessionName = this.makeSessionName();
    this.addSession(this.sessionName);
    this.saveSessions();
    this.pushSessions();
    this.pushSessionHistory(this.sessionName);
    this.restartRunningProcessForSessionChange();
  }

  switchSession(session: string): void {
    if (!session.trim()) {
      return;
    }
    this.sessionName = session.trim();
    this.addSession(this.sessionName);
    this.saveSessions();
    this.pushSessions();
    this.pushSessionHistory(this.sessionName);
    this.restartRunningProcessForSessionChange();
  }

  private restartRunningProcessForSessionChange(): void {
    if (!this.proc || this.proc.killed) {
      this.startProcess();
      return;
    }
    this.restartAfterStop = true;
    this.stopProcess();
  }

  private sendToProcess(text: string): void {
    if (!text.trim()) {
      return;
    }
    if (!this.proc || this.proc.killed) {
      this.startProcess();
    }
    this.post({ type: "clearAssistantBuffer" });
    this.pendingAssistantChunk = false;
    this.sendRaw(text);
  }

  private sendRaw(text: string): void {
    if (!this.proc || this.proc.killed) {
      this.post({ type: "status", text: "dongshan chat is not running.", level: "warn" });
      return;
    }
    this.proc.stdin.write(`${text}\n`);
  }

  private pushAssistantText(text: string): void {
    if (!text.trim()) {
      return;
    }
    if (!this.pendingAssistantChunk) {
      this.pendingAssistantChunk = true;
    }
    this.post({ type: "assistantChunk", text });
  }

  private handleProcessStdout(text: string): void {
    const merged = this.execConfirmBuffer + cleanPromptEcho(text);
    const parsed = extractExecConfirmPrompts(merged);
    this.execConfirmBuffer = parsed.tail;
    for (const item of parsed.prompts) {
      this.execConfirmQueue.push(item);
    }
    if (parsed.display.trim()) {
      this.pushAssistantText(parsed.display);
    }
    void this.drainExecConfirmQueue();
  }

  private async drainExecConfirmQueue(): Promise<void> {
    if (this.execConfirmInFlight) {
      return;
    }
    this.execConfirmInFlight = true;
    try {
      while (this.execConfirmQueue.length > 0) {
        const item = this.execConfirmQueue.shift();
        if (!item) {
          continue;
        }
        if (!this.proc || this.proc.killed) {
          break;
        }
        const picked = await vscode.window.showWarningMessage(
          `Run command?\n${item.command}`,
          { modal: true },
          "确定",
          "不",
          `总是允许 ${item.prefix}`,
          "停止"
        );
        let reply = "n";
        if (picked === "确定") {
          reply = "y";
        } else if (picked?.startsWith("总是允许")) {
          reply = "a";
        } else if (picked === "停止") {
          reply = "q";
        }
        this.sendRaw(reply);
      }
    } finally {
      this.execConfirmInFlight = false;
    }
  }

  private async pickAndInsertFileCommand(): Promise<void> {
    type CmdPick = vscode.QuickPickItem & { cmd: "read" | "askfile" | "grep" | "list" };
    const picked = await vscode.window.showQuickPick(
      <CmdPick[]>[
        { label: "/read", detail: "Read file content", cmd: "read" },
        { label: "/askfile", detail: "Read file then ask model", cmd: "askfile" },
        { label: "/grep", detail: "Search keyword in file/folder", cmd: "grep" },
        { label: "/list", detail: "List files in folder", cmd: "list" }
      ],
      { placeHolder: "Select a command template to insert" }
    );
    if (!picked) {
      return;
    }
    if (picked.cmd === "list") {
      const uri = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
      });
      const rel = this.toWorkspacePath(uri?.[0]) ?? "src";
      this.insertIntoInput(`/list ${quoteIfNeeded(rel)}`, false);
      return;
    }
    const uri = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: picked.cmd === "grep",
      canSelectMany: false,
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
    });
    const cmd = this.buildCommandFromUri(
      picked.cmd === "read" ? "read" : picked.cmd === "askfile" ? "askfile" : "grep",
      uri?.[0]
    );
    if (cmd) {
      this.insertIntoInput(cmd, false);
    }
  }

  private buildCommandFromUri(kind: "read" | "askfile" | "grep", uri?: vscode.Uri): string | undefined {
    const rel = this.toWorkspacePath(uri);
    if (!rel) {
      return undefined;
    }
    if (kind === "read") {
      return `/read ${quoteIfNeeded(rel)}`;
    }
    if (kind === "askfile") {
      return `/askfile ${quoteIfNeeded(rel)} Please explain this code and suggest improvements`;
    }
    return `/grep "TODO" ${quoteIfNeeded(rel)}`;
  }

  private toWorkspacePath(uri?: vscode.Uri): string | undefined {
    if (!uri) {
      return undefined;
    }
    return vscode.workspace.asRelativePath(uri, false) || uri.fsPath;
  }

  private async refreshModelAndPromptState(showStatus: boolean): Promise<void> {
    const [promptRes, modelRes] = await Promise.all([
      this.runDongshanCommand(["prompt", "list"]),
      this.runDongshanCommand(["models", "list"])
    ]);
    if (promptRes.code !== 0) {
      this.post({
        type: "status",
        text: `prompt list failed: ${promptRes.stderr || promptRes.stdout || `exit ${promptRes.code}`}`,
        level: "warn"
      });
    }
    if (modelRes.code !== 0) {
      this.post({
        type: "status",
        text: `models list failed: ${modelRes.stderr || modelRes.stdout || `exit ${modelRes.code}`}`,
        level: "warn"
      });
    }
    const promptState = parsePromptListOutput(promptRes.stdout);
    const modelState = parseModelListOutput(modelRes.stdout);
    this.post({
      type: "metaState",
      prompts: promptState.prompts,
      activePrompt: promptState.activePrompt,
      models: modelState.models,
      activeModel: modelState.activeModel
    });
    if (showStatus) {
      this.post({ type: "status", text: "Prompt/model list refreshed.", level: "info" });
    }
  }

  private async usePrompt(name: string): Promise<void> {
    if (!name.trim()) {
      return;
    }
    const res = await this.runDongshanCommand(["prompt", "use", name]);
    if (res.code !== 0) {
      this.post({
        type: "status",
        text: `Failed to switch prompt: ${res.stderr || res.stdout || `exit ${res.code}`}`,
        level: "error"
      });
      return;
    }
    if (this.proc && !this.proc.killed) {
      this.sendRaw(`/prompt use ${name}`);
    }
    this.post({ type: "status", text: `Active prompt switched to: ${name}`, level: "info" });
    await this.refreshModelAndPromptState(false);
  }

  private async useModel(name: string): Promise<void> {
    if (!name.trim()) {
      return;
    }
    const res = await this.runDongshanCommand(["models", "use", name]);
    if (res.code !== 0) {
      this.post({
        type: "status",
        text: `Failed to switch model: ${res.stderr || res.stdout || `exit ${res.code}`}`,
        level: "error"
      });
      return;
    }
    if (this.proc && !this.proc.killed) {
      this.sendRaw(`/model use ${name}`);
    }
    this.post({ type: "status", text: `Active model switched to: ${name}`, level: "info" });
    await this.refreshModelAndPromptState(false);
  }

  private async addModel(msg: { name: string; baseUrl?: string; apiKeyEnv?: string; apiKey?: string }): Promise<void> {
    const name = msg.name.trim();
    if (!name) {
      this.post({ type: "status", text: "Model name cannot be empty.", level: "warn" });
      return;
    }
    const args = ["models", "add", name];
    if (msg.baseUrl?.trim()) {
      args.push("--base-url", msg.baseUrl.trim());
    }
    if (msg.apiKeyEnv?.trim()) {
      args.push("--api-key-env", msg.apiKeyEnv.trim());
    }
    if (msg.apiKey?.trim()) {
      args.push("--api-key", msg.apiKey.trim());
    }
    const res = await this.runDongshanCommand(args);
    if (res.code !== 0) {
      this.post({
        type: "status",
        text: `Failed to add model: ${res.stderr || res.stdout || `exit ${res.code}`}`,
        level: "error"
      });
      return;
    }
    this.post({ type: "status", text: `Model added: ${name}`, level: "info" });
    await this.refreshModelAndPromptState(false);
  }

  private runDongshanCommand(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const cmd = this.cfg().get<string>("executable", "dongshan");
      const cwd = this.workspaceFolderPath() ?? process.cwd();
      let stdout = "";
      let stderr = "";
      let child: ChildProcessWithoutNullStreams | undefined;
      try {
        child = spawn(cmd, args, { cwd, stdio: "pipe", shell: false });
      } catch (err) {
        resolve({ code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
        return;
      }
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += stripAnsi(chunk.toString("utf8"));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += stripAnsi(chunk.toString("utf8"));
      });
      child.on("error", (err) => {
        stderr += err.message;
      });
      child.on("close", (code) => {
        resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
      });
    });
  }

  private post(msg: ToWebview): void {
    this.view?.webview.postMessage(msg);
  }

  private bootstrapSessions(): void {
    if (this.sessions.length > 0 && this.sessionName) {
      return;
    }
    const persisted = this.context.globalState.get<string[]>("dongshan.sessions", []);
    const disk = this.listDongshanSessionsFromDisk();
    const merged = [...new Set([...persisted, ...disk])].filter((x) => x.trim().length > 0);
    this.sessions = merged.slice(0, 40);
    if (this.sessions.length === 0) {
      this.sessionName = this.makeSessionName();
      this.sessions = [this.sessionName];
      this.saveSessions();
      return;
    }
    const last = this.context.globalState.get<string>("dongshan.lastSession");
    this.sessionName = last && this.sessions.includes(last) ? last : this.sessions[0];
  }

  private addSession(session: string): void {
    this.sessions = [session, ...this.sessions.filter((x) => x !== session)].slice(0, 40);
  }

  private saveSessions(): void {
    void this.context.globalState.update("dongshan.sessions", this.sessions);
    void this.context.globalState.update("dongshan.lastSession", this.sessionName);
  }

  private pushSessions(): void {
    this.post({ type: "sessions", sessions: this.sessions, active: this.sessionName });
  }

  private listDongshanSessionsFromDisk(): string[] {
    try {
      const dir = path.join(os.homedir(), ".dongshan", "sessions");
      if (!fs.existsSync(dir)) {
        return [];
      }
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/i, ""))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  private pushSessionHistory(session: string): void {
    const messages = this.loadSessionMessages(session);
    this.post({ type: "hydrateHistory", messages });
  }

  private loadSessionMessages(session: string): Array<{ role: string; content: string }> {
    try {
      const file = path.join(os.homedir(), ".dongshan", "sessions", `${session}.json`);
      if (!fs.existsSync(file)) {
        return [];
      }
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .map((m) => {
          const role = typeof m?.role === "string" ? m.role : "";
          const content = typeof m?.content === "string" ? m.content : "";
          return { role, content };
        })
        .filter((m) => m.role.length > 0 && m.content.length > 0);
    } catch {
      return [];
    }
  }

  private cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("dongshanChat");
  }

  private workspaceFolderPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private makeSessionName(): string {
    const ws = vscode.workspace.name ?? "workspace";
    const normalized = ws.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 20) || "workspace";
    const rand = Math.floor(Math.random() * 100000).toString(36);
    return `vscode-${normalized}-${rand}`;
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const maxRenderedMessages = Math.max(20, this.cfg().get<number>("maxRenderedMessages", 80));
    const mermaidUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "node_modules", "mermaid", "dist", "mermaid.min.js")
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource};" />
  <title>Dongshan Chat</title>
  <style>
    :root {
      --bg: #0f1520;
      --bg-panel: #131c2a;
      --line: #2a3a53;
      --text: #e8eefc;
      --text-dim: #97a6c6;
      --accent: #4eb8ff;
      --user: #233a61;
      --assistant: #1b2a3f;
      --warn: #ffc977;
      --err: #ff8e8e;
      --ok: #7be3b0;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      background: radial-gradient(1200px 400px at -20% -30%, #223861 0%, transparent 60%), var(--bg);
      font-family: Consolas, "Cascadia Mono", "Courier New", monospace;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      padding: 10px;
      border-bottom: 1px solid var(--line);
      background: color-mix(in srgb, var(--bg-panel) 92%, black);
    }
    .meta {
      display: grid;
      grid-template-columns: 1fr 1fr auto auto;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
      background: #101a2a;
      align-items: center;
    }
    .meta button {
      padding: 4px 8px;
    }
    button {
      border: 1px solid var(--line);
      background: #19263b;
      color: var(--text);
      border-radius: 8px;
      padding: 4px 10px;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    select {
      border: 1px solid var(--line);
      background: #19263b;
      color: var(--text);
      border-radius: 8px;
      padding: 4px 8px;
      min-width: 140px;
      max-width: 220px;
    }
    .dot {
      width: 9px; height: 9px; border-radius: 999px; display: inline-block;
      background: #677086;
      margin-left: auto;
    }
    .dot.on { background: #34d399; }
    #messages {
      flex: 1;
      overflow: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .notice {
      border: 1px dashed #35527e;
      color: var(--text-dim);
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 12px;
      background: #122039;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .notice button {
      margin-left: auto;
      padding: 2px 8px;
    }
    .msg {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px 10px;
      white-space: pre-wrap;
      line-height: 1.4;
    }
    .msg.user { background: var(--user); }
    .msg.assistant { background: var(--assistant); }
    .msg h1, .msg h2, .msg h3 { margin: 0 0 8px; font-size: 14px; }
    .msg p { margin: 0 0 8px; }
    .msg ul, .msg ol { margin: 0 0 8px 18px; padding: 0; }
    .msg li { margin-bottom: 4px; }
    .msg code.inline { background: #0f1726; border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; }
    .codewrap { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-bottom: 8px; }
    .codebar { display: flex; align-items: center; gap: 8px; background: #152135; padding: 4px 8px; font-size: 12px; color: var(--text-dim); }
    .copy { margin-left: auto; border: 1px solid var(--line); background: #213251; color: var(--text); border-radius: 6px; padding: 2px 8px; cursor: pointer; }
    .copy.ok { border-color: var(--ok); color: var(--ok); }
    pre { margin: 0; background: #0f1726; padding: 10px; overflow-x: auto; }
    .mermaid-wrap {
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: auto;
      background: #f8fafc;
      color: #0f172a;
      padding: 10px;
      margin-bottom: 8px;
    }
    .events {
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      background: #101a2a;
      max-height: 100px;
      overflow: auto;
      padding: 6px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .event {
      font-size: 12px;
      color: var(--text-dim);
      border-left: 2px solid #3a5379;
      padding-left: 8px;
      white-space: pre-wrap;
    }
    .status {
      color: var(--text-dim);
      font-size: 12px;
      padding: 6px 10px;
      min-height: 24px;
    }
    .status.warn { color: var(--warn); }
    .status.error { color: var(--err); }
    .input {
      padding: 10px;
      border-top: 1px solid var(--line);
      background: var(--bg-panel);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    textarea {
      width: 100%;
      min-height: 90px;
      resize: vertical;
      color: var(--text);
      background: #0f1726;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      font-family: inherit;
      line-height: 1.4;
    }
    .send-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .tip {
      color: var(--text-dim);
      font-size: 12px;
      margin-left: auto;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <select id="sessions"></select>
    <button id="start">Start</button>
    <button id="stop">Stop</button>
    <button id="new">New</button>
    <button id="attach">Attach</button>
    <span id="running" class="dot"></span>
  </div>
  <div class="meta">
    <select id="promptSel"></select>
    <select id="modelSel"></select>
    <button id="addModel">Add Model</button>
    <button id="refreshMeta">Refresh</button>
  </div>
  <div id="messages"></div>
  <div id="events" class="events"></div>
  <div id="status" class="status"></div>
  <div class="input">
    <textarea id="input" placeholder="Ask dongshan..."></textarea>
    <div class="send-row">
      <button id="send">Send</button>
      <span class="tip">Ctrl/Cmd+Enter to send</span>
    </div>
  </div>
  <script src="${mermaidUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById("messages");
    const status = document.getElementById("status");
    const events = document.getElementById("events");
    const running = document.getElementById("running");
    const input = document.getElementById("input");
    const sessions = document.getElementById("sessions");
    const promptSel = document.getElementById("promptSel");
    const modelSel = document.getElementById("modelSel");
    let assistantEl = null;
    let codeCounter = 0;
    let hiddenCount = 0;
    let archivedMessages = [];
    const MAX_RENDERED_MESSAGES = ${maxRenderedMessages};

    if (window.mermaid) {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        theme: "default"
      });
    }

    function upsertOverflowNotice() {
      let notice = document.getElementById("overflowNotice");
      if (!notice) {
        notice = document.createElement("div");
        notice.id = "overflowNotice";
        notice.className = "notice";
        messages.prepend(notice);
      }
      notice.innerHTML = "";
      const text = document.createElement("span");
      text.textContent = "Folded old messages: " + hiddenCount + ". Showing latest " + MAX_RENDERED_MESSAGES + ".";
      const btn = document.createElement("button");
      btn.textContent = "Expand";
      btn.addEventListener("click", () => expandAllMessages());
      notice.appendChild(text);
      notice.appendChild(btn);
    }

    function pruneMessagesIfNeeded() {
      const real = Array.from(messages.querySelectorAll(".msg"));
      if (real.length <= MAX_RENDERED_MESSAGES) {
        return;
      }
      const extra = real.length - MAX_RENDERED_MESSAGES;
      for (let i = 0; i < extra; i += 1) {
        const node = real[i];
        archivedMessages.push(node.cloneNode(true));
        node.remove();
      }
      hiddenCount += extra;
      upsertOverflowNotice();
    }

    function expandAllMessages() {
      if (!archivedMessages.length) {
        return;
      }
      const anchor = document.getElementById("overflowNotice");
      const frag = document.createDocumentFragment();
      archivedMessages.forEach((node) => frag.appendChild(node));
      if (anchor && anchor.nextSibling) {
        messages.insertBefore(frag, anchor.nextSibling);
      } else {
        messages.appendChild(frag);
      }
      archivedMessages = [];
      hiddenCount = 0;
      if (anchor) {
        anchor.remove();
      }
    }

    function addMsg(role, text) {
      const uiRole = role === "user" ? "user" : "assistant";
      const el = document.createElement("div");
      el.className = "msg " + uiRole;
      if (uiRole === "assistant") {
        el.innerHTML = renderMarkdown(text);
        bindCopyButtons(el);
        renderMermaid(el);
      } else {
        el.textContent = text;
      }
      messages.appendChild(el);
      pruneMessagesIfNeeded();
      messages.scrollTop = messages.scrollHeight;
      return el;
    }

    function resetConversationView() {
      messages.innerHTML = "";
      events.innerHTML = "";
      assistantEl = null;
      hiddenCount = 0;
      archivedMessages = [];
    }

    function setStatus(text, level) {
      status.textContent = text || "";
      status.className = "status" + (level ? " " + level : "");
    }

    function addEvent(line) {
      const el = document.createElement("div");
      el.className = "event";
      el.textContent = line;
      events.appendChild(el);
      while (events.children.length > 120) events.removeChild(events.firstChild);
      events.scrollTop = events.scrollHeight;
    }

    function classifyAndPushEvents(text) {
      const lines = text.split(/\\n+/).map(s => s.trim()).filter(Boolean);
      for (const line of lines) {
        const tool = line.match(/tool\\[([^\\]]+)\\]/i);
        if (tool) addEvent("tool: " + tool[1] + " | " + line.slice(0, 220));
        else if (/\\b(exec|command|run|shell|error|warn)\\b/i.test(line)) addEvent(line.slice(0, 220));
      }
    }

    function escapeHtml(s) {
      return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function renderMarkdown(text) {
      const ticks = String.fromCharCode(96).repeat(3);
      const codeBlocks = [];
      const blockRe = new RegExp(ticks + "([a-zA-Z0-9_-]*)\\\\n([\\\\s\\\\S]*?)" + ticks, "g");
      const masked = text.replace(blockRe, (_, lang, code) => {
        const idx = codeBlocks.length;
        codeBlocks.push({
          lang: (lang || "text").trim(),
          code: code.replace(/\\n$/, "")
        });
        return "@@CODEBLOCK_" + idx + "@@";
      });

      const lines = masked.split("\\n");
      const out = [];
      let inUl = false;
      let inOl = false;
      let inP = false;

      function closeLists() {
        if (inUl) {
          out.push("</ul>");
          inUl = false;
        }
        if (inOl) {
          out.push("</ol>");
          inOl = false;
        }
      }

      function closeParagraph() {
        if (inP) {
          out.push("</p>");
          inP = false;
        }
      }

      function renderInline(raw) {
        let s = escapeHtml(raw);
        s = s.replace(/\x60([^\x60\\n]+)\x60/g, '<code class="inline">$1</code>');
        s = s.replace(/\\*\\*([^*\\n]+)\\*\\*/g, "<strong>$1</strong>");
        return s;
      }

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        const t = line.trim();

        if (!t) {
          closeParagraph();
          closeLists();
          continue;
        }

        const codeToken = t.match(/^@@CODEBLOCK_(\\d+)@@$/);
        if (codeToken) {
          closeParagraph();
          closeLists();
          out.push(t);
          continue;
        }

        const h3 = t.match(/^###\\s+(.+)$/);
        if (h3) {
          closeParagraph();
          closeLists();
          out.push("<h3>" + renderInline(h3[1]) + "</h3>");
          continue;
        }
        const h2 = t.match(/^##\\s+(.+)$/);
        if (h2) {
          closeParagraph();
          closeLists();
          out.push("<h2>" + renderInline(h2[1]) + "</h2>");
          continue;
        }
        const h1 = t.match(/^#\\s+(.+)$/);
        if (h1) {
          closeParagraph();
          closeLists();
          out.push("<h1>" + renderInline(h1[1]) + "</h1>");
          continue;
        }

        const ol = t.match(/^(\\d+)\\.\\s+(.+)$/);
        if (ol) {
          closeParagraph();
          if (inUl) {
            out.push("</ul>");
            inUl = false;
          }
          if (!inOl) {
            out.push("<ol>");
            inOl = true;
          }
          out.push("<li>" + renderInline(ol[2]) + "</li>");
          continue;
        }

        const ul = t.match(/^[-*]\\s+(.+)$/);
        if (ul) {
          closeParagraph();
          if (inOl) {
            out.push("</ol>");
            inOl = false;
          }
          if (!inUl) {
            out.push("<ul>");
            inUl = true;
          }
          out.push("<li>" + renderInline(ul[1]) + "</li>");
          continue;
        }

        closeLists();
        if (!inP) {
          out.push("<p>");
          inP = true;
          out.push(renderInline(line.trim()));
        } else {
          out.push("<br/>" + renderInline(line.trim()));
        }
      }

      closeParagraph();
      closeLists();
      let html = out.join("");
      html = html.replace(/@@CODEBLOCK_(\\d+)@@/g, (_, iStr) => {
        const i = Number(iStr);
        const entry = codeBlocks[i];
        if (!entry) {
          return "";
        }
        const id = "code-" + (codeCounter++);
        const safeCode = escapeHtml(entry.code);
        const label = escapeHtml(entry.lang || "text");
        if (entry.lang.toLowerCase() === "mermaid") {
          const encoded = btoa(unescape(encodeURIComponent(entry.code)));
          return '<div class="mermaid-wrap"><div class="mermaid-block" data-mermaid="' + encoded + '"></div></div>';
        }
        return '<div class="codewrap">' +
          '<div class="codebar"><span>' + label + '</span><button class="copy" data-copy-target="' + id + '">Copy</button></div>' +
          '<pre><code id="' + id + '">' + safeCode + '</code></pre>' +
          '</div>';
      });
      return html;
    }

    function renderMermaid(root) {
      const blocks = root.querySelectorAll(".mermaid-block");
      if (!blocks.length || !window.mermaid) {
        return;
      }
      blocks.forEach((block) => {
        if (block.dataset.rendered === "1") {
          return;
        }
        const encoded = block.getAttribute("data-mermaid") || "";
        let code = "";
        try {
          code = decodeURIComponent(escape(atob(encoded)));
        } catch (_) {
          code = "";
        }
        const node = document.createElement("div");
        node.className = "mermaid";
        node.textContent = code;
        block.appendChild(node);
        block.dataset.rendered = "1";
      });
      try {
        window.mermaid.run({ querySelector: ".mermaid" });
      } catch (_) {}
    }

    function bindCopyButtons(root) {
      root.querySelectorAll("button.copy").forEach((btn) => {
        if (btn.dataset.bound === "1") return;
        btn.dataset.bound = "1";
        btn.addEventListener("click", async () => {
          const id = btn.getAttribute("data-copy-target");
          const codeEl = id ? document.getElementById(id) : null;
          if (!codeEl) return;
          try {
            await navigator.clipboard.writeText(codeEl.textContent || "");
            btn.classList.add("ok");
            btn.textContent = "Copied";
            setTimeout(() => {
              btn.classList.remove("ok");
              btn.textContent = "Copy";
            }, 1000);
          } catch (_) {}
        });
      });
    }

    function sendText() {
      const text = input.value.trim();
      if (!text) return;
      addMsg("user", text);
      assistantEl = null;
      vscode.postMessage({ type: "send", text });
      input.value = "";
    }

    document.getElementById("send").addEventListener("click", sendText);
    document.getElementById("start").addEventListener("click", () => vscode.postMessage({ type: "start" }));
    document.getElementById("stop").addEventListener("click", () => vscode.postMessage({ type: "stop" }));
    document.getElementById("new").addEventListener("click", () => {
      assistantEl = null;
      addMsg("assistant", "[new session]");
      vscode.postMessage({ type: "newSession" });
    });
    document.getElementById("attach").addEventListener("click", () => vscode.postMessage({ type: "pickFileCommand" }));
    document.getElementById("refreshMeta").addEventListener("click", () => vscode.postMessage({ type: "refreshMeta" }));
    document.getElementById("addModel").addEventListener("click", () => {
      const name = window.prompt("Model name (required)");
      if (!name || !name.trim()) return;
      const baseUrl = window.prompt("Base URL (optional)", "") || "";
      const apiKeyEnv = window.prompt("API key env var (optional, e.g. OPENAI_API_KEY)", "") || "";
      const apiKey = window.prompt("API key literal (optional)", "") || "";
      vscode.postMessage({ type: "addModel", name: name.trim(), baseUrl, apiKeyEnv, apiKey });
    });
    promptSel.addEventListener("change", () => {
      if (promptSel.value) vscode.postMessage({ type: "usePrompt", name: promptSel.value });
    });
    modelSel.addEventListener("change", () => {
      if (modelSel.value) vscode.postMessage({ type: "useModel", name: modelSel.value });
    });
    sessions.addEventListener("change", () => {
      const val = sessions.value;
      if (val) vscode.postMessage({ type: "switchSession", session: val });
    });

    input.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        sendText();
      }
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "assistantChunk") {
        if (!assistantEl) assistantEl = addMsg("assistant", "");
        const full = (assistantEl.dataset.raw || "") + msg.text;
        assistantEl.dataset.raw = full;
        assistantEl.innerHTML = renderMarkdown(full);
        bindCopyButtons(assistantEl);
        renderMermaid(assistantEl);
        classifyAndPushEvents(msg.text);
        pruneMessagesIfNeeded();
        messages.scrollTop = messages.scrollHeight;
      } else if (msg.type === "status") {
        setStatus(msg.text, msg.level);
      } else if (msg.type === "running") {
        running.classList.toggle("on", !!msg.value);
      } else if (msg.type === "clearAssistantBuffer") {
        assistantEl = null;
      } else if (msg.type === "sessions") {
        const current = sessions.value;
        sessions.innerHTML = "";
        msg.sessions.forEach((name) => {
          const opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          sessions.appendChild(opt);
        });
        sessions.value = msg.active || current;
      } else if (msg.type === "insertInput") {
        if (msg.append) {
          input.value = (input.value ? input.value + "\\n" : "") + msg.text;
        } else {
          input.value = msg.text;
        }
        input.focus();
      } else if (msg.type === "metaState") {
        const pCurrent = promptSel.value;
        promptSel.innerHTML = "";
        (msg.prompts || []).forEach((name) => {
          const opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          promptSel.appendChild(opt);
        });
        promptSel.value = msg.activePrompt || pCurrent;

        const mCurrent = modelSel.value;
        modelSel.innerHTML = "";
        (msg.models || []).forEach((name) => {
          const opt = document.createElement("option");
          opt.value = name;
          opt.textContent = name;
          modelSel.appendChild(opt);
        });
        modelSel.value = msg.activeModel || mCurrent;
      } else if (msg.type === "hydrateHistory") {
        resetConversationView();
        (msg.messages || []).forEach((m) => {
          addMsg(m.role, m.content);
        });
      }
    });
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new DongshanChatProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DongshanChatProvider.viewId, provider),
    vscode.commands.registerCommand("dongshanChat.start", () => provider.startProcess()),
    vscode.commands.registerCommand("dongshanChat.stop", () => provider.stopProcess()),
    vscode.commands.registerCommand("dongshanChat.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("dongshanChat.sendSelection", () => provider.sendSelection()),
    vscode.commands.registerCommand("dongshanChat.fileRead", (uri?: vscode.Uri) => provider.insertCommandForUri("read", uri)),
    vscode.commands.registerCommand("dongshanChat.fileAsk", (uri?: vscode.Uri) => provider.insertCommandForUri("askfile", uri)),
    vscode.commands.registerCommand("dongshanChat.fileGrep", (uri?: vscode.Uri) => provider.insertCommandForUri("grep", uri)),
    vscode.commands.registerCommand("dongshanChat.insertCommandGuide", () => provider.insertIntoInput(buildCommandGuide(), false)),
    { dispose: () => provider.dispose() }
  );
}

export function deactivate(): void {}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*m/g, "");
}

function cleanPromptEcho(input: string): string {
  return input.replace(/^\s*you>\s?/gm, "");
}

function extractExecConfirmPrompts(input: string): {
  display: string;
  prompts: Array<{ command: string; prefix: string }>;
  tail: string;
} {
  const re = /\[exec-confirm\]\s*Run command `([^`]+)` \? \[y=yes\]\/\[n=no\]\/\[a=always `([^`]+)`\]\/\[q=stop\]:\s*/g;
  const prompts: Array<{ command: string; prefix: string }> = [];
  let display = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    display += input.slice(last, m.index);
    prompts.push({ command: m[1].trim(), prefix: m[2].trim() });
    last = re.lastIndex;
  }
  let remainder = input.slice(last);
  const partialIdx = remainder.lastIndexOf("[exec-confirm]");
  let tail = "";
  if (partialIdx >= 0) {
    display += remainder.slice(0, partialIdx);
    tail = remainder.slice(partialIdx);
  } else {
    display += remainder;
  }
  return { display, prompts, tail };
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i += 1) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function quoteIfNeeded(p: string): string {
  if (/\s/.test(p)) {
    return `"${p.replace(/"/g, '\\"')}"`;
  }
  return p;
}

function buildCommandGuide(): string {
  return [
    "## `dongshan chat` core commands",
    "### `/read <file>`",
    "- Read and print file content only.",
    "- Example: `/read src/chat.rs`",
    "",
    "### `/list [path]`",
    "- List files under a path.",
    "- Example: `/list src`",
    "",
    "### `/grep <pattern> [path]`",
    "- Search text in path.",
    "- Example: `/grep timeout src`",
    "",
    "### `/askfile <file> <question>`",
    "- Read file and ask model to analyze it.",
    "- Example: `/askfile src/llm.rs 为什么超时？`",
    "",
    "Quick usage:",
    "- raw content: `/read`",
    "- structure: `/list`",
    "- keyword locate: `/grep`",
    "- analysis: `/askfile`"
  ].join("\n");
}

function parsePromptListOutput(output: string): { activePrompt: string; prompts: string[] } {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let active = "";
  const prompts: string[] = [];
  for (const line of lines) {
    const mActive = line.match(/^Active:\s*(.+)$/i);
    if (mActive) {
      active = mActive[1].trim();
      continue;
    }
    const mItem = line.match(/^-+\s*([^:]+):/);
    if (mItem) {
      prompts.push(mItem[1].trim());
    }
  }
  if (active && !prompts.includes(active)) {
    prompts.unshift(active);
  }
  return { activePrompt: active, prompts: dedupe(prompts) };
}

function parseModelListOutput(output: string): { activeModel: string; models: string[] } {
  // Keep leading spaces because CLI uses "  name" for non-active models.
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0);
  let active = "";
  const models: string[] = [];
  for (const line of lines) {
    const mActive = line.trim().match(/^Current model:\s*(.+)$/i);
    if (mActive) {
      active = mActive[1].trim();
      continue;
    }
    const mItem = line.match(/^[* ]\s+(.+)$/);
    if (mItem) {
      models.push(mItem[1].trim());
    }
  }
  if (active && !models.includes(active)) {
    models.unshift(active);
  }
  return { activeModel: active, models: dedupe(models) };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter((x) => x.trim().length > 0))];
}


