# Dongshan VS Code Chat

This extension embeds local `dongshan chat` into a VS Code sidebar and gives you an IDE chat workflow close to Codex/Claude style.

## Features

- Sidebar chat UI in VS Code activity bar (`Dongshan`).
- Multi-session list + Start/Stop/New/Switch controls.
- Streaming stdout/stderr from local `dongshan chat`.
- Send editor selection to chat with command: `Dongshan: Send Editor Selection`.
- Assistant Markdown rendering with fenced code block copy button.
- Mermaid rendering for fenced blocks: `\`\`\`mermaid`.
- Tool/command event stream panel (auto-detected from output lines).
- Auto-fold old messages when chat history is long (render latest N messages only).
- Fold area has `Expand` button to temporarily restore old message bubbles.
- Explorer right-click supports inserting `/read`, `/askfile`, `/grep` for selected file/path.
- Chat toolbar supports `Attach` (pick file command).
- Prompt and model selectors in extension UI auto-apply on selection, plus `Add Model`.
- When opening/switching a session, chat bubbles are hydrated from `~/.dongshan/sessions/<session>.json`.

## Prerequisites

- `dongshan` must be installed and available in your PATH, or configure executable path:
  - `dongshanChat.executable`
- Configure model/provider first:
  - `dongshan onboard`
  - or `dongshan config ...`

## Run in development

```powershell
npm install
npm run compile
vsce package
```

Then press `F5` in VS Code to launch Extension Development Host.

## Extension settings

- `dongshanChat.executable`: command/path for executable (default: `dongshan`)
- `dongshanChat.extraArgs`: extra args appended after `dongshan chat --session ...`
- `dongshanChat.autoStart`: auto start chat when panel opens
- `dongshanChat.maxRenderedMessages`: max message bubbles kept rendered in UI (default `80`)

## Notes

- This version bridges interactive CLI via stdin/stdout (no custom JSON protocol required).
- If `dongshan` outputs terminal control sequences, extension strips common ANSI colors.
