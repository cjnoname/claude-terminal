// Optional Claude Code hooks for exact event detection.
// Each hook invocation writes ONE file into an events directory (temp file + rename, so
// concurrent hooks never interleave). Every VS Code window reads new files; old files are
// garbage-collected after a while. `tid` identifies the VS Code terminal (CLAUDE_TERMINAL_ID).
const { psEncoded } = require('./sound');

const HOOK_MARKER = 'claude-terminal-events';
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop'];

/**
 * The command is home-relative ($HOME / %USERPROFILE%) so a settings.json synced between machines
 * stays valid, and it deletes event files older than an hour itself, so nothing piles up even
 * if the extension is disabled or uninstalled.
 */
function hookCommand(platform) {
  if (platform === 'win32') {
    return psEncoded([
      `$d = Join-Path $env:USERPROFILE '.claude\\${HOOK_MARKER}'`,
      '[Console]::InputEncoding = [Text.Encoding]::UTF8',
      'New-Item -ItemType Directory -Force -Path $d | Out-Null',
      'Get-ChildItem -Path $d -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-1) } | Remove-Item -Force -ErrorAction SilentlyContinue',
      "$i = [Console]::In.ReadToEnd() -replace '\\r?\\n', ' '",
      "$f = Join-Path $d ('{0}-{1}-{2}' -f [DateTimeOffset]::Now.ToUnixTimeMilliseconds(), $PID, (Get-Random))",
      "[IO.File]::WriteAllText(\"$f.tmp\", ('{\"tid\":\"' + $env:CLAUDE_TERMINAL_ID + '\",\"event\":' + $i + '}'), (New-Object Text.UTF8Encoding $false))",
      'Move-Item -Force "$f.tmp" "$f.json"',
    ].join('\n'));
  }
  return [
    `d="$HOME/.claude/${HOOK_MARKER}"`,
    'mkdir -p "$d"',
    '{ find "$d" -type f -mmin +60 -delete 2>/dev/null || true; }',
    'f="$d/$(date +%s)-$$-$(od -An -N4 -tu4 /dev/urandom | tr -d \' \')"',
    '{ printf \'{"tid":"%s","event":\' "${CLAUDE_TERMINAL_ID:-}"; tr -d \'\\n\\r\'; echo \'}\'; } > "$f.tmp"',
    'mv -f "$f.tmp" "$f.json"',
  ].join(' && ');
}

function decodedCommand(cmd) {
  const s = String(cmd || '');
  const m = /-EncodedCommand\s+(\S+)/.exec(s);
  if (!m) return s;
  try { return Buffer.from(m[1], 'base64').toString('utf16le'); } catch { return s; }
}

/** Matches hook commands written by this extension (any version). */
function isOurs(cmd) {
  return decodedCommand(cmd).includes(HOOK_MARKER);
}

/** @returns {'none'|'current'|'outdated'} */
function hooksStatus(settings, platform) {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object') return 'none';
  const commandsOf = (arr) => (Array.isArray(arr) ? arr : []).flatMap((m) => (m?.hooks || []).map((h) => h?.command));
  const anyOurs = Object.values(hooks).some((arr) => commandsOf(arr).some(isOurs));
  if (!anyOurs) return 'none';
  const expected = hookCommand(platform);
  const complete = HOOK_EVENTS.every((ev) => {
    const ours = commandsOf(hooks[ev]).filter(isOurs);
    return ours.length === 1 && ours[0] === expected;
  });
  const stray = Object.keys(hooks).some((ev) => !HOOK_EVENTS.includes(ev) && commandsOf(hooks[ev]).some(isOurs));
  return complete && !stray ? 'current' : 'outdated';
}

function removeHooks(settings) {
  const s = JSON.parse(JSON.stringify(settings || {}));
  if (!s.hooks || typeof s.hooks !== 'object') return s;
  for (const ev of Object.keys(s.hooks)) {
    if (!Array.isArray(s.hooks[ev])) continue;
    s.hooks[ev] = s.hooks[ev]
      .map((m) => ({ ...m, hooks: (m?.hooks || []).filter((h) => !isOurs(h?.command)) }))
      .filter((m) => m.hooks.length > 0);
    if (s.hooks[ev].length === 0) delete s.hooks[ev];
  }
  if (Object.keys(s.hooks).length === 0) delete s.hooks;
  return s;
}

function addHooks(settings, platform) {
  const s = removeHooks(settings);
  s.hooks = s.hooks || {};
  const command = hookCommand(platform);
  for (const ev of HOOK_EVENTS) {
    s.hooks[ev] = [...(s.hooks[ev] || []), { hooks: [{ type: 'command', command }] }];
  }
  return s;
}

/** Parses an event file: `{tid, event}`. */
function parseHookLine(line) {
  try {
    const o = JSON.parse(String(line).replace(/^\uFEFF/, ''));
    if (o && o.event && typeof o.event === 'object') return { tid: typeof o.tid === 'string' ? o.tid : '', event: o.event };
  } catch {}
  return null;
}

module.exports = { HOOK_MARKER, HOOK_EVENTS, hookCommand, hooksStatus, addHooks, removeHooks, parseHookLine, isOurs };
