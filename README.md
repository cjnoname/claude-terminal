# Claude Terminal

> **Unofficial community extension.** Not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" is a trademark of Anthropic, PBC.

Run the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview) next to your code with one shortcut. Then switch to something else. This extension tells you **when Claude finishes** and, just as important, **when Claude is stuck waiting for your permission**. You get a sound, a desktop notification, or a push to your phone, and one click takes you back to the right session.

## Why

Claude Code often runs for minutes at a time. Most of that time you're either watching the terminal, or you switch away and come back to find it sat waiting on a permission prompt for ten minutes. This extension fixes both.

## Features

### 🔔 Alerts
- **Two kinds of alert**: *finished* and *needs your input* (permission prompt, question, plan review), each with its own sound.
- **Permission detection without setup.** The extension reads your `permissions.allow / deny / ask` rules and the current permission mode. It stays quiet for tool calls that run automatically (for example `Read` or `npm run check*`) and alerts you quickly when a call will need your approval.
- **Precise mode (optional).** One command installs Claude Code hooks for exact events, and each alert is linked to the terminal tab it came from.
- **Task duration** in the alert ("finished · my-app (3m 12s)"). You can also set a minimum duration so quick answers don't trigger an alert.
- **Desktop notifications** when VS Code is in the background (macOS, Windows, Linux).
- **📱 Phone push** through **ntfy**, **Bark**, **Telegram** or any **webhook**. A push is sent only if the alert is still unanswered after N seconds and you're away from VS Code.
- **No noise.** It stays quiet if you're already looking at that session. Each window only tracks its own workspace, so other windows don't repeat the alert. You can also mute everything (Do Not Disturb), set **quiet hours**, or turn on an optional **repeat reminder** and **voice announcement**.
- **Sound control.** Adjustable volume, 14 macOS sounds with live preview, or any wav/mp3/aiff file on every platform.

### 🗂 Sessions view
An activity-bar panel that lists recent sessions in this workspace, with their live status: **needs input**, **working**, **finished** or **idle**. Click a session to jump to its terminal, or resume it in a new one. You can also copy the session ID or open the transcript.

### ⌨️ Terminal
| Shortcut | Action |
|---|---|
| `Cmd/Ctrl+F1` | Open Claude, or focus the one already open |
| `Cmd/Ctrl+Shift+F1` | New parallel session |
| `Cmd/Ctrl+Alt+F1` | Jump to the session that needs you |
| `Cmd/Ctrl+Alt+K` | Send the current selection to Claude as `@file#L10-20` |

The extension also has **Continue Last Conversation** and **Resume a Conversation…** commands, plus "Send File to Claude" in the Explorer context menu. You can set a custom command or arguments, and choose whether Claude opens in the editor area or the panel.

### 📊 Usage
The status bar shows today's token usage across all sessions, broken down by model, with an estimate at public API prices.

## Precise mode

Run **Claude Terminal: Enable Precise Alerts**. This adds `SessionStart`, `UserPromptSubmit`, `Notification` and `Stop` hooks to `~/.claude/settings.json`.

- Your other settings and hooks are kept. The file is updated atomically, a timestamped backup is saved, and symlinked dotfiles are written through.
- Each hook writes one small file to `~/.claude/claude-terminal-events/`. Files older than an hour are deleted automatically. Nothing leaves your machine.
- To undo it, run **Remove Claude Code Hooks**. Uninstalling the extension removes the hooks too.
- `~/.claude` is shared by VS Code, Insiders, Cursor and other editors. If you use this extension in more than one of them, uninstalling it from one also removes the hooks for the others. Run **Enable Precise Alerts** again there.
- Without precise mode, sessions started from this extension are still linked to their terminal exactly, because they launch with `claude --session-id <uuid>`. If your `terminal.command` is a wrapper that doesn't accept Claude Code flags, turn off `claudeTerminal.terminal.assignSessionId`.

## Phone notifications

Run **Claude Terminal: Set Up Phone Notifications…** and pick one:
- **ntfy** – free and no account needed. Install the ntfy app and subscribe to the topic the setup generates.
- **Bark** (iOS) – paste your `https://api.day.app/<key>` URL.
- **Telegram** – a bot token from @BotFather plus your chat ID.
- **Webhook** – receives a POST with JSON `{title, message, kind}`.

Credentials are stored in VS Code's secure storage, not in `settings.json`. By default a push only says *"Claude finished"* or *"Claude needs your input"*. The `claudeTerminal.push.content` setting can add the project name, or the reply summary and the command waiting for approval. A push is sent only if the alert is still unanswered after `push.delaySeconds` and no VS Code window is focused.

## Privacy & security

- Everything is processed locally. The only network requests are the phone pushes you configure.
- Settings that run commands or reach the network (`terminal.command`, `terminal.args`, custom sound files, push provider and server) can only be set in **user** settings. A repository's `.vscode/settings.json` cannot change them.

## Requirements

- The Claude Code CLI must be installed and available on your `PATH`.

## Development

```bash
npm ci
npm run check   # lint + tests
```


## License

MIT
