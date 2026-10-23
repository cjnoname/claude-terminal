# Changelog

## 2.0.2
- Removed "Unofficial" wording from the listing.

## 2.0.1
- New original icon.
- Sessions view in the activity bar: live status, jump to a session or resume it.
- Permission-prompt detection based on your Claude Code permission rules and mode, including messages with several tool calls.
- New sessions launch with `--session-id`, so alerts are linked to the exact terminal even without hooks.
- Optional precise mode using Claude Code hooks: each event is written to its own file (safe when several sessions fire at once), the hook commands are home-relative and clean up after themselves, and the hooks are removed on uninstall. Sessions whose hooks aren't running still alert through transcript detection.
- Phone push via ntfy, Bark, Telegram or webhook. Credentials are kept in secure storage, pushes contain no project details by default, and muting or responding cancels a pending push.
- Only one VS Code window alerts for a given event. Windows without a folder only track their own terminals. Runs of `claude -p` started by a tool never alert.
- Task duration shown in alerts; optional minimum duration; quiet hours; voice announcements; Windows desktop notifications; volume control and custom sound files on every platform.
- Send the current selection or a file to Claude as an `@file#L` mention. If Claude isn't running yet, the mention is copied to the clipboard instead.
- Today's token usage in the status bar: read incrementally, resets at midnight, unknown models are not priced, and custom prices can be set.
- `~/.claude/settings.json` is written atomically, with a backup and conflict detection.
- Settings that run commands are user-level only, so a workspace cannot override them.
- If you turned sounds off in 1.x (`notification.sound`), they stay off (now `sound.enabled`).
- Fixed: missed alerts when the transcript ended with metadata lines or a new project folder was created; duplicate alerts across windows; stale alerts when old sessions were touched.

## 1.3.1
- Open Claude CLI in the editor area with Cmd+F1, plus a sound and status bar bell when Claude finishes.
