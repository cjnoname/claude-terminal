const vscode = require('vscode');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const util = require('./util');
const transcript = require('./transcript');
const permissions = require('./permissions');
const sound = require('./sound');
const hooks = require('./hooks');
const jsonFile = require('./jsonFile');
const claims = require('./claims');
const { UsageStatus } = require('./ui/usageStatus');
const { SessionsProvider } = require('./ui/sessionsView');
const { PushService } = require('./ui/pushService');
const soundPicker = require('./ui/soundPicker');

// ── Constants ────────────────────────────────────────────────────────────────

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const EVENTS_DIR = path.join(CLAUDE_DIR, hooks.HOOK_MARKER);
const CLAIMS_DIR = path.join(CLAUDE_DIR, 'claude-terminal-state', 'claims');
const FOCUS_FILE = path.join(CLAUDE_DIR, 'claude-terminal-state', 'focus');
const TERMINAL_NAME = 'Claude';
const ENV_TID = 'CLAUDE_TERMINAL_ID';
const ENV_SID = 'CLAUDE_TERMINAL_SESSION';
/** User-supplied flags that can't be combined with --session-id. */
const CONFLICTING_ARGS_RE = /(^|\s)(-c|--continue|-r|--resume|--session-id|-p|--print)(\s|=|$)/;
const PLACEHOLDER_TTL_MS = 60 * 1000;
const DEBOUNCE_MS = 800;
const ASK_DELAY_MS = 2500;
/** For sessions whose hooks are known to work, transcript-based alerts wait this long for the hook to arrive first. */
const HOOK_GRACE_MS = 5000;
const MIN_SOUND_GAP_MS = 1500;
const STALE_MS = 15 * 60 * 1000; // a "running" session silent for this long is shown as idle
const EVENT_TTL_MS = 10 * 60 * 1000;
const EVENTS_POLL_MS = 3000;
/** Transcript entries older than this never raise alerts (e.g. Claude appending metadata to an old session). */
const FRESH_MS = 2 * 60 * 1000;
const NON_OWNER_CLAIM_DELAY_MS = 700;
const FOCUS_STAMP_MS = 10 * 1000;

// ── State ────────────────────────────────────────────────────────────────────

/** @type {vscode.ExtensionContext} */ let ctx;
/** @type {vscode.LogOutputChannel} */ let out;
let bellItem, dndItem, treeView, treeProvider;
/** @type {UsageStatus} */ let usage;
/** @type {PushService} */ let pushService;

/** @type {Map<string, vscode.Terminal>} */ const terminalsById = new Map();
/** @type {Map<vscode.Terminal, {id: string, createdAt: number, cwd: string, sessionId?: string}>} */ const terminalInfo = new Map();
let lastActiveTerminal = null;

/**
 * @typedef {{id: string, file?: string, cwd?: string, title?: string, status: string, message?: string,
 *   updatedAt: number, promptAt?: number, activityAt?: number, terminalId?: string, branch?: string}} Session
 * @type {Map<string, Session>}
 */
const sessions = new Map();
/** @type {Map<string, {kind: 'done'|'attention', message: string, at: number, project: string}>} */
const pending = new Map();
/** Last alert per session (also when suppressed) — used to de-duplicate hook vs transcript detection. */
const lastAlert = new Map();
/** Sessions that have delivered at least one hook event, i.e. whose hooks demonstrably work. */
const hookedSessions = new Set();

let hookState = 'none';
let repeatTimer = null;
let lastSound = { at: 0, kind: '' };
let dirWatchers = new Map();
let rootWatcher = null;
let eventsWatcher = null;
let eventsPoll = null;
let eventsScanTimer = null;
const seenEvents = new Set();
let settingsWatcher = null;
const fileTimers = new Map();
/** @type {Map<string, {uuid: string, timer: NodeJS.Timeout}>} file -> pending permission check */
const permTimers = new Map();
/** @type {Map<string, NodeJS.Timeout>} `${sid}:${kind}` -> transcript fallback waiting for a hook */
const fallbackTimers = new Map();
const handledKeys = new Map();
/** sessionId -> delayed claim for windows that don't own the session */
const claimTimers = new Map();
let tickTimer = null;
let focusTimer = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function cfg(key) {
  return vscode.workspace.getConfiguration('claudeTerminal').get(key);
}

/**
 * Is a session relevant to this window?
 * - Sessions running in one of this window's terminals always are.
 * - A window without folders only tracks sessions started in its own terminals (no duplicate alerts from empty windows).
 */
function isInScope(cwd, tid) {
  if (tid && terminalsById.has(tid)) return true;
  if (cfg('notification.scope') === 'all') return true;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    if (!cwd) return false;
    const c = util.normalizePath(cwd);
    return [...terminalInfo.values()].some((i) => i.cwd && util.normalizePath(i.cwd) === c);
  }
  return !!cwd && folders.some((f) => util.isPathInside(cwd, f.uri.fsPath));
}

function projectName(cwd) {
  return cwd ? path.basename(cwd) : '';
}

function run(cmd, label) {
  exec(cmd, { windowsHide: true, timeout: 30000 }, (err) => { if (err) out.warn(`${label} failed: ${err.message}`); });
}

function isDnd() {
  return ctx.globalState.get('dnd', false);
}

function isQuiet() {
  return isDnd() || util.inQuietHours(cfg('notification.quietHours'));
}

function clearMapTimer(map, key) {
  const v = map.get(key);
  if (v) clearTimeout(v.timer || v);
  map.delete(key);
}

// ── Terminals ────────────────────────────────────────────────────────────────

function newTerminalId() {
  return `ct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function adoptTerminal(t, id, cwd, createdAt = Date.now(), assignedSid) {
  terminalsById.set(id, t);
  terminalInfo.set(t, { id, createdAt, cwd, assignedSid });
}

function liveTerminals() {
  return vscode.window.terminals.filter((t) => terminalInfo.has(t));
}

function terminalForSession(sessionId) {
  const s = sessions.get(sessionId);
  return s?.terminalId ? terminalsById.get(s.terminalId) : undefined;
}

/**
 * The bound terminal, but only if the binding is proven: we launched the session with
 * --session-id / --resume <id>, or a hook reported the terminal id. Guessed bindings are only
 * used for "jump to", never to suppress or acknowledge alerts.
 */
function confidentTerminal(sessionId) {
  const t = terminalForSession(sessionId);
  return t && sessions.get(sessionId)?.bindExact ? t : undefined;
}

/** @param {boolean} exact true when proven (hook terminal id / explicit resume), false when guessed */
function bindSession(sessionId, tid, exact) {
  const t = terminalsById.get(tid);
  if (!t) return;
  let s = sessions.get(sessionId);
  if (s?.terminalId === tid && s.bindExact && !exact) return; // never downgrade a proven binding
  if (!s && exact) {
    s = { id: sessionId, status: 'idle', updatedAt: Date.now(), cwd: terminalInfo.get(t).cwd };
    sessions.set(sessionId, s);
  }
  for (const info of terminalInfo.values()) if (info.sessionId === sessionId && info.id !== tid) info.sessionId = undefined;
  for (const o of sessions.values()) if (o.terminalId === tid && o.id !== sessionId) { o.terminalId = undefined; o.bindExact = false; }
  terminalInfo.get(t).sessionId = sessionId;
  if (s) { s.terminalId = tid; s.bindExact = !!exact; }
  const map = { ...ctx.workspaceState.get('sessionTerminals', {}) };
  for (const [k, v] of Object.entries(map)) if (v?.tid === tid || !terminalsById.has(v?.tid)) delete map[k];
  map[sessionId] = { tid, exact: !!exact };
  ctx.workspaceState.update('sessionTerminals', map);
}

function storedBinding(sessionId) {
  return ctx.workspaceState.get('sessionTerminals', {})[sessionId] || null;
}

/** Without hooks: bind a session to our terminal only when exactly one terminal could own it. */
function guessTerminal(session, activityAt) {
  if (session.terminalId && terminalsById.has(session.terminalId) && session.bindExact) return;
  const launched = [...terminalInfo.values()].find((i) => i.assignedSid === session.id);
  if (launched) { bindSession(session.id, launched.id, true); return; }
  if (session.terminalId && terminalsById.has(session.terminalId)) return;
  const stored = storedBinding(session.id);
  if (stored && terminalsById.has(stored.tid)) { bindSession(session.id, stored.tid, stored.exact); return; }
  if (!activityAt) return;
  const candidates = [...terminalInfo.values()]
    .filter((i) => !i.sessionId && i.createdAt > 0 && i.createdAt <= activityAt + 5000)
    .filter((i) => !session.cwd || !i.cwd || util.normalizePath(i.cwd) === util.normalizePath(session.cwd));
  if (candidates.length === 1) bindSession(session.id, candidates[0].id, false);
}

function terminalLocation() {
  if (cfg('terminal.location') === 'panel') return vscode.TerminalLocation.Panel;
  const hasEditors = vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => !(t.input instanceof vscode.TabInputTerminal)));
  return hasEditors && cfg('terminal.openToSide') ? { viewColumn: vscode.ViewColumn.Beside } : vscode.TerminalLocation.Editor;
}

function defaultCwd() {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const folder = (uri && vscode.workspace.getWorkspaceFolder(uri)) || vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath || os.homedir();
}

function uniqueTerminalName() {
  const used = new Set(vscode.window.terminals.map((t) => t.name));
  if (!used.has(TERMINAL_NAME)) return TERMINAL_NAME;
  for (let i = 2; ; i++) if (!used.has(`${TERMINAL_NAME} (${i})`)) return `${TERMINAL_NAME} (${i})`;
}

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,127}$/;

async function createClaudeTerminal({ args = [], cwd, resumeId } = {}) {
  if (resumeId && !SESSION_ID_RE.test(resumeId)) {
    vscode.window.showErrorMessage('Invalid Claude session id.');
    return undefined;
  }
  const id = newTerminalId();
  const dir = cwd || defaultCwd();
  const userArgs = `${cfg('terminal.command') || ''} ${cfg('terminal.args') || ''}`;
  const assignedSid = !args.length && cfg('terminal.assignSessionId') && !CONFLICTING_ARGS_RE.test(userArgs) ? crypto.randomUUID() : undefined;
  const terminal = vscode.window.createTerminal({
    name: uniqueTerminalName(),
    location: terminalLocation(),
    iconPath: vscode.Uri.joinPath(ctx.extensionUri, 'media', 'terminal.svg'),
    cwd: dir,
    env: assignedSid ? { [ENV_TID]: id, [ENV_SID]: assignedSid } : { [ENV_TID]: id },
  });
  adoptTerminal(terminal, id, dir, Date.now(), assignedSid);
  lastActiveTerminal = terminal;
  if (resumeId) bindSession(resumeId, id, true);

  const base = (cfg('terminal.command') || 'claude').trim();
  const extra = (cfg('terminal.args') || '').trim();
  // A fresh session gets an id we choose, so we know exactly which transcript belongs to this terminal.
  if (assignedSid) {
    args = ['--session-id', assignedSid];
    bindSession(assignedSid, id, true);
  }
  terminal.sendText([base, extra, ...args].filter(Boolean).join(' '));
  terminal.show(false);
  return terminal;
}

function showTerminal(t) {
  t.show(false);
  lastActiveTerminal = t;
}

function preferredTerminal() {
  const list = liveTerminals();
  return lastActiveTerminal && list.includes(lastActiveTerminal) ? lastActiveTerminal : list[list.length - 1];
}

async function openOrFocus() {
  const t = cfg('terminal.reuseExisting') ? preferredTerminal() : undefined;
  if (t) {
    showTerminal(t);
    acknowledgeTerminal(t);
    return;
  }
  await createClaudeTerminal();
}

/** Jump to the session that most needs attention. */
async function jumpToClaude() {
  const entries = [...pending.entries()].sort((a, b) =>
    (a[1].kind === b[1].kind ? 0 : a[1].kind === 'attention' ? -1 : 1) || b[1].at - a[1].at);
  for (const [sid] of entries) {
    const t = terminalForSession(sid);
    if (t) { showTerminal(t); acknowledge(sid); return; }
  }
  if (entries.length) { await openSession(entries[0][0]); return; }
  await openOrFocus();
}

/** Focus the session's terminal, or resume it in a new one. The alert is only cleared once the user actually gets there. */
async function openSession(sessionId) {
  const t = terminalForSession(sessionId);
  if (t) { showTerminal(t); acknowledge(sessionId); return; }
  const s = sessions.get(sessionId);
  if (s && Date.now() - s.updatedAt < 2 * 60 * 1000 && (s.status === 'running' || s.status === 'attention')) {
    const pick = await vscode.window.showWarningMessage(
      'This session looks active in another terminal or window. Resuming it here as well would run it twice.',
      { modal: true }, 'Resume Anyway');
    if (pick !== 'Resume Anyway') return;
  }
  const created = await createClaudeTerminal({ args: ['--resume', sessionId], cwd: s?.cwd && fs.existsSync(s.cwd) ? s.cwd : undefined, resumeId: sessionId });
  if (created) acknowledge(sessionId);
}

/**
 * True only if we *know* the user is looking at this session's terminal.
 * Unbound / ambiguously-bound sessions never count, and neither does the panel
 * (VS Code keeps activeTerminal set even when the panel is hidden).
 */
function isLookingAt(sessionId) {
  if (!vscode.window.state.focused) return false;
  if (cfg('terminal.location') === 'panel') return false;
  const bound = confidentTerminal(sessionId);
  if (!bound || vscode.window.activeTerminal !== bound) return false;
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return !!tab && tab.input instanceof vscode.TabInputTerminal;
}

// ── Send context to Claude ───────────────────────────────────────────────────

function mention(uri, range, baseDir) {
  let rel = baseDir ? path.relative(baseDir, uri.fsPath) : vscode.workspace.asRelativePath(uri, false);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) rel = uri.fsPath;
  if (process.platform === 'win32') rel = rel.replace(/\\/g, '/');
  if (/\s/.test(rel)) rel = `"${rel}"`;
  if (!range) return `@${rel}`;
  const start = range.start.line + 1;
  let end = range.end.line + 1;
  if (range.end.character === 0 && range.end.line > range.start.line) end--;
  return start === end ? `@${rel}#L${start}` : `@${rel}#L${start}-${end}`;
}

/** Types text into the Claude prompt. If no Claude is running yet we can't know when it's ready, so copy instead. */
async function deliverToClaude(build) {
  const t = preferredTerminal();
  if (t) {
    t.sendText(build(terminalInfo.get(t)?.cwd), false);
    showTerminal(t);
    return;
  }
  const text = build(defaultCwd());
  await vscode.env.clipboard.writeText(text);
  await createClaudeTerminal();
  vscode.window.showInformationMessage(`Claude is starting. The reference was copied — paste it (${process.platform === 'darwin' ? '⌘V' : 'Ctrl+V'}) once Claude is ready.`);
}

async function sendSelection() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== 'file') return;
  await deliverToClaude((base) => [...new Set(ed.selections.map((s) => mention(ed.document.uri, s.isEmpty ? null : s, base)))].join(' ') + ' ');
}

async function sendFiles(uri, uris) {
  const list = (uris && uris.length ? uris : [uri || vscode.window.activeTextEditor?.document.uri]).filter((u) => u && u.scheme === 'file');
  if (!list.length) return;
  await deliverToClaude((base) => list.map((u) => mention(u, null, base)).join(' ') + ' ');
}

// ── Alerts ───────────────────────────────────────────────────────────────────

function playSound(kind, force = false) {
  const now = Date.now();
  // Within the gap only an 'attention' sound may interrupt a 'done' sound, never the other way round.
  if (!force && now - lastSound.at < MIN_SOUND_GAP_MS && !(kind === 'attention' && lastSound.kind !== 'attention')) return;
  lastSound = { at: now, kind };
  const volume = Math.max(0, Math.min(100, Number(cfg('sound.volume')) || 0)) / 100;
  if (volume === 0) return;
  const custom = cfg(`sound.${kind}.customFile`);
  const file = custom && fs.existsSync(custom) ? custom : undefined;
  if (custom && !file) out.warn(`Custom ${kind} sound not found; using default`);
  run(sound.buildPlayCommand({ platform: process.platform, kind, file, name: cfg(`sound.${kind}.name`), volume }), 'Sound');
}

/** Was an alert of this kind already raised for this session after `sinceMs`? */
function alreadyAlerted(sessionId, kind, sinceMs) {
  const la = lastAlert.get(sessionId);
  return !!la && la.kind === kind && la.at >= sinceMs;
}

/**
 * @param {'done'|'attention'} kind
 * @param {string} sessionId
 * @param {{message?: string, durationMs?: number, project?: string, dedupKey?: string, foreign?: boolean}} info
 *   dedupKey: identical in every VS Code window for the same event — only one window makes noise.
 *   foreign: the event came from another window's terminal — that window handles sound/push.
 */
function raiseAlert(kind, sessionId, info = {}) {
  const s = sessions.get(sessionId);
  const now = Date.now();
  lastAlert.set(sessionId, { kind, at: now });
  clearMapTimer(fallbackTimers, `${sessionId}:${kind}`);
  if (s) {
    s.status = kind === 'done' ? 'done' : 'attention';
    if (info.message) s.message = info.message;
    s.updatedAt = now;
  }
  scheduleTreeRefresh();

  if (!cfg(kind === 'done' ? 'notification.onDone' : 'notification.onAttention')) return;
  const minSecs = Number(cfg('notification.minDurationSeconds')) || 0;
  if (kind === 'done' && minSecs > 0 && info.durationMs !== undefined && info.durationMs < minSecs * 1000) {
    out.info(`Skip done alert: task took ${util.formatDuration(info.durationMs)} (< ${minSecs}s)`);
    return;
  }
  // Claim first (even when we end up suppressing), so no other window makes noise for an
  // alert the user is already looking at. Windows that don't own the session give the owner a head start.
  const key = info.dedupKey || `${sessionId}:${kind}:${now}`;
  if (!info.claimed && !info.foreign && !terminalForSession(sessionId)) {
    clearMapTimer(claimTimers, sessionId);
    claimTimers.set(sessionId, setTimeout(() => {
      claimTimers.delete(sessionId);
      const cur = sessions.get(sessionId);
      if (cur && Math.max(cur.promptAt || 0, cur.activityAt || 0) > now) return; // user responded meanwhile
      raiseAlert(kind, sessionId, { ...info, claimed: claims.claim(CLAIMS_DIR, key) ? 'won' : 'lost' });
    }, NON_OWNER_CLAIM_DELAY_MS));
    return;
  }
  const owner = !info.foreign && (info.claimed ? info.claimed === 'won' : claims.claim(CLAIMS_DIR, key));
  if (cfg('notification.suppressWhenFocused') && isLookingAt(sessionId)) {
    out.info(`Suppressed ${kind} alert: user is looking at the session`);
    return;
  }

  const project = info.project || projectName(s?.cwd);
  const duration = info.durationMs !== undefined ? util.formatDuration(info.durationMs) : '';
  const title = kind === 'done'
    ? `Claude finished${project ? ` · ${project}` : ''}${duration ? ` (${duration})` : ''}`
    : `Claude needs your input${project ? ` · ${project}` : ''}`;
  const message = info.message || (kind === 'done' ? 'Task complete' : 'Waiting for you');

  pending.set(sessionId, { kind, message, at: now, project });
  updateBell();

  out.info(`Alert: ${kind}${project ? ` · ${project}` : ''}${owner ? '' : ' (handled by another window)'}`);
  if (!owner) return;

  if (!isQuiet()) {
    if (cfg('sound.enabled')) playSound(kind);
    if (cfg('sound.speak')) {
      const phrase = kind === 'done' ? `Claude finished${project ? ' in ' + project : ''}` : `Claude needs your input${project ? ' in ' + project : ''}`;
      setTimeout(() => run(sound.buildSpeakCommand(process.platform, phrase), 'Speech'), 600);
    }
    if (cfg('notification.systemNotification') && !vscode.window.state.focused) {
      const body = cfg('notification.showDetails') ? message : (kind === 'done' ? 'Task complete' : 'Waiting for you');
      run(sound.buildSystemNotificationCommand(process.platform, title, body), 'System notification');
    }
    if (cfg('notification.showMessage')) {
      const show = kind === 'attention' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
      show(`${title}: ${message}`, 'Go to Claude').then((a) => { if (a) return openSession(sessionId); }).catch((e) => out.error(String(e)));
    }
  }
  pushService.schedule(sessionId, kind, { project, message }, () => {
    const p = pending.get(sessionId);
    return !!p && p.at === now && p.kind === kind;
  });
  scheduleRepeat();
}

/** Any VS Code window focused recently? Each focused window refreshes a shared timestamp file. */
function stampFocus() {
  if (!vscode.window.state.focused) return;
  try {
    fs.mkdirSync(path.dirname(FOCUS_FILE), { recursive: true });
    const t = new Date();
    try { fs.utimesSync(FOCUS_FILE, t, t); } catch { fs.writeFileSync(FOCUS_FILE, ''); }
  } catch {}
}

function userAtVsCode() {
  if (vscode.window.state.focused) return true;
  try { return Date.now() - fs.statSync(FOCUS_FILE).mtimeMs < FOCUS_STAMP_MS * 1.5; } catch { return false; }
}

function pushMuted() {
  return isDnd() || (cfg('push.respectQuietHours') && util.inQuietHours(cfg('notification.quietHours')));
}

/**
 * 1.x had a single `notification.sound` switch (now `sound.enabled`). Respect users who turned it off,
 * at the same level (user / workspace) they set it.
 */
async function migrateV1Settings() {
  const conf = vscode.workspace.getConfiguration('claudeTerminal');
  const old = conf.inspect('notification.sound');
  const cur = conf.inspect('sound.enabled');
  for (const [target, oldValue, newValue] of [
    [vscode.ConfigurationTarget.Global, old?.globalValue, cur?.globalValue],
    [vscode.ConfigurationTarget.Workspace, old?.workspaceValue, cur?.workspaceValue],
  ]) {
    if (oldValue === undefined) continue;
    if (oldValue === false && newValue === undefined) await conf.update('sound.enabled', false, target);
    await conf.update('notification.sound', undefined, target);
  }
}

function scheduleRepeat() {
  clearTimeout(repeatTimer);
  const secs = Number(cfg('sound.repeatAttentionSeconds')) || 0;
  if (secs <= 0) return;
  repeatTimer = setTimeout(() => {
    const waiting = [...pending.entries()].filter(([sid, p]) => p.kind === 'attention' && !isLookingAt(sid));
    if (waiting.length && !isQuiet() && cfg('sound.enabled')) playSound('attention', true);
    if (waiting.length) scheduleRepeat();
  }, secs * 1000);
}

function acknowledge(sessionId) {
  clearMapTimer(claimTimers, sessionId);
  if (pending.delete(sessionId)) {
    pushService.cancel(sessionId);
    updateBell();
  }
  scheduleTreeRefresh();
  if (![...pending.values()].some((p) => p.kind === 'attention')) clearTimeout(repeatTimer);
}

/** Only a session confidently bound to this terminal is acknowledged — never guess. */
function acknowledgeTerminal(t) {
  const sid = terminalInfo.get(t)?.sessionId;
  if (sid && confidentTerminal(sid) === t) acknowledge(sid);
}

function clearAlerts() {
  for (const sid of [...pending.keys()]) acknowledge(sid);
}

function updateBell() {
  if (!pending.size || !cfg('notification.showBell')) {
    bellItem.hide();
  } else {
    const items = [...pending.values()];
    const attention = items.filter((p) => p.kind === 'attention').length;
    bellItem.text = attention
      ? `$(bell-dot) Claude needs input${pending.size > 1 ? ` (${pending.size})` : ''}`
      : `$(check-all) Claude finished${pending.size > 1 ? ` (${pending.size})` : ''}`;
    bellItem.backgroundColor = new vscode.ThemeColor(attention ? 'statusBarItem.errorBackground' : 'statusBarItem.warningBackground');
    const md = new vscode.MarkdownString();
    for (const p of items) {
      md.appendMarkdown(`${p.kind === 'attention' ? '⚠️' : '✅'} **`);
      md.appendText(p.project || 'Claude');
      md.appendMarkdown('** — ');
      md.appendText(p.message);
      md.appendMarkdown('\n\n');
    }
    md.appendMarkdown('_Click to jump there_');
    bellItem.tooltip = md;
    bellItem.show();
  }
  if (treeView) {
    const attention = [...pending.values()].filter((p) => p.kind === 'attention').length;
    treeView.badge = pending.size ? { value: pending.size, tooltip: attention ? `${attention} waiting for input` : `${pending.size} finished` } : undefined;
  }
}

// ── Session state from transcripts ───────────────────────────────────────────

function upsertSession(file, a, bindable = true) {
  const id = a.sessionId || path.basename(file, '.jsonl');
  let s = sessions.get(id);
  if (!s) {
    s = { id, file, status: 'unknown', updatedAt: 0 };
    sessions.set(id, s);
  }
  s.file = file;
  if (a.cwd) s.cwd = a.cwd;
  if (a.gitBranch) s.branch = a.gitBranch;
  if (a.title) s.title = util.summarize(a.title, 70);
  if (!s.title && !s.titleLooked) { s.titleLooked = true; s.title = transcript.sessionTitle(file); }
  if (!s.title && a.lastPromptText) s.title = a.lastPromptText;
  if (a.lastPromptAt) s.promptAt = Math.max(s.promptAt || 0, a.lastPromptAt);
  s.updatedAt = Math.max(s.updatedAt, a.lastAt || 0);
  if (bindable) guessTerminal(s, a.lastAt);
  return s;
}

/**
 * Raise an alert detected from the transcript, unless a hook already reported it.
 * Sessions with working hooks get a grace period so the (more precise) hook wins.
 */
function transcriptAlert(kind, s, entryAt, info) {
  const since = (entryAt || Date.now()) - 1000;
  const key = `${s.id}:${kind}`;
  const fire = () => {
    fallbackTimers.delete(key);
    if (alreadyAlerted(s.id, kind, since)) return;
    raiseAlert(kind, s.id, info);
  };
  clearMapTimer(fallbackTimers, key);
  if (!hookedSessions.has(s.id)) { fire(); return; }
  fallbackTimers.set(key, setTimeout(fire, HOOK_GRACE_MS));
}

function cancelPermissionCheck(file) {
  clearMapTimer(permTimers, file);
}

function checkTranscript(file) {
  const a = transcript.analyze(transcript.readRecent(file));
  if (!a.last || a.nonInteractive || childSessions.has(a.sessionId)) return;
  const known = sessions.get(a.sessionId || path.basename(file, '.jsonl'));
  if (!isInScope(a.cwd, known?.terminalId)) return;
  const s = upsertSession(file, a);
  const uuid = a.last.uuid || `${a.lastAt}`;

  // A pending permission check is only cancelled when the conversation actually moved on.
  const pc = permTimers.get(file);
  if (pc && pc.uuid !== uuid) cancelPermissionCheck(file);

  const key = `${uuid}:${a.status}`;
  const fresh = handledKeys.get(file) !== key && Date.now() - (a.lastAt || 0) < FRESH_MS;
  handledKeys.set(file, key);
  const project = projectName(a.cwd);
  const dedupKey = `${s.id}:${uuid}`;

  switch (a.status) {
    case 'running':
    case 'interrupted':
      s.status = a.status === 'running' ? 'running' : 'idle';
      s.activityAt = Math.max(s.activityAt || 0, a.lastAt || 0);
      clearMapTimer(fallbackTimers, `${s.id}:done`);
      clearMapTimer(fallbackTimers, `${s.id}:attention`);
      // A new prompt or tool result means the user has responded
      if (pending.has(s.id) && a.lastAt > pending.get(s.id).at) acknowledge(s.id);
      break;
    case 'done':
      if (s.status !== 'attention') s.status = 'done';
      if (!fresh) break;
      transcriptAlert('done', s, a.lastAt, { message: a.message, durationMs: a.lastPromptAt ? a.lastAt - a.lastPromptAt : undefined, project, dedupKey: `${dedupKey}:done` });
      break;
    case 'ask':
      s.status = 'attention';
      if (fresh) transcriptAlert('attention', s, a.lastAt, { message: a.message, project, dedupKey: `${dedupKey}:ask` });
      break;
    case 'tool': {
      s.status = 'running';
      if (!fresh || permTimers.has(file) || !cfg('notification.detectPermissionPrompts')) break;
      const ctxPerm = { mode: a.permissionMode, rules: permissions.loadRules(a.cwd), cwd: a.cwd };
      const verdict = permissions.classifyAll(a.toolBlocks, ctxPerm);
      out.debug(`Tool call → ${verdict}`);
      if (verdict === 'allow' || verdict === 'deny') break;
      const blocking = a.toolBlocks.find((b) => permissions.classify(b, ctxPerm) === verdict) || a.toolBlocks[0];
      const what = blocking ? transcript.describeTool(blocking) : a.message;
      const delay = verdict === 'ask' ? ASK_DELAY_MS : Math.max(2, Number(cfg('notification.permissionDelaySeconds')) || 8) * 1000;
      const timer = setTimeout(() => {
        permTimers.delete(file);
        const latest = transcript.analyze(transcript.readRecent(file));
        if ((latest.last?.uuid || `${latest.lastAt}`) !== uuid) return;
        transcriptAlert('attention', s, a.lastAt, { message: 'Permission needed — ' + what, project, dedupKey: `${dedupKey}:perm` });
      }, delay);
      permTimers.set(file, { uuid, timer });
      break;
    }
  }
  scheduleTreeRefresh();
}

/** transcript file -> {inScope, at}; cleared when folders/scope change */
const fileScopeCache = new Map();
const UNDECIDED_RETRY_MS = 5000;

/**
 * Does a transcript belong to this window? The directory name usually encodes the cwd, but Claude
 * shortens very long paths, the encoding is lossy and case can differ — so when the name doesn't
 * match, read the real cwd from the start of this file once and cache it per file.
 */
function fileInScope(file) {
  const folders = vscode.workspace.workspaceFolders;
  if (cfg('notification.scope') === 'all' || !folders?.length) return true;
  const name = path.basename(path.dirname(file));
  if (folders.some((f) => util.projectDirMatches(name, f.uri.fsPath))) return true;
  const hit = fileScopeCache.get(file);
  if (hit && (hit.inScope !== undefined || Date.now() - hit.at < UNDECIDED_RETRY_MS)) return hit.inScope ?? true;
  const cwd = transcript.readHead(file, 16 * 1024).find((e) => e.cwd)?.cwd;
  const inScope = cwd ? isInScope(cwd) : undefined; // undecided: brand-new file without a cwd line yet
  fileScopeCache.set(file, { inScope, at: Date.now() });
  return inScope ?? true;
}

/**
 * Cheap pre-filter before reading a transcript's tail: with workspace scope, other projects'
 * Claude activity shouldn't cost a 256 KB read on every write. Errs on the side of reading.
 */
function mightBeRelevant(file) {
  const id = path.basename(file, '.jsonl');
  if (sessions.has(id) || [...terminalInfo.values()].some((i) => i.assignedSid === id)) return true;
  if (fileInScope(file)) return true;
  // Sessions started in one of our terminals, wherever the user cd'd to
  const name = path.basename(path.dirname(file));
  return [...terminalInfo.values()].some((i) => i.cwd && util.projectDirMatches(name, i.cwd));
}

function onTranscriptChanged(file) {
  usage?.markDirty();
  if (!mightBeRelevant(file)) return;
  clearMapTimer(fileTimers, file);
  fileTimers.set(file, setTimeout(() => { fileTimers.delete(file); checkTranscript(file); }, DEBOUNCE_MS));
}

function watchDir(dir, catchUp = false) {
  if (dirWatchers.has(dir)) return;
  try {
    const w = fs.watch(dir, (_e, name) => { if (name && name.endsWith('.jsonl')) onTranscriptChanged(path.join(dir, name)); });
    w.on('error', () => { try { w.close(); } catch {} dirWatchers.delete(dir); });
    dirWatchers.set(dir, w);
  } catch { return; }
  if (!catchUp) return;
  // A brand-new project dir: its first transcript may have been written before the watcher existed.
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      if (Date.now() - fs.statSync(file).mtimeMs < 60 * 1000) onTranscriptChanged(file);
    }
  } catch {}
}

function scanProjects(catchUp = false) {
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) if (d.isDirectory()) watchDir(path.join(PROJECTS_DIR, d.name), catchUp);
  } catch {}
}


/** Populate the session list from recent transcripts (no alerts). */
function loadRecentSessions() {
  const since = Date.now() - (Number(cfg('sessions.recentHours')) || 24) * 3600 * 1000;
  let dirs;
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return; }
  const files = [];
  for (const d of dirs) {
    const dir = path.join(PROJECTS_DIR, d.name);
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(dir, f);
        const st = fs.statSync(file);
        if (st.mtimeMs >= since && st.size > 0 && fileInScope(file)) files.push({ file, mtime: st.mtimeMs });
      }
    } catch {}
  }
  files.sort((x, y) => y.mtime - x.mtime);
  for (const { file, mtime } of files.slice(0, 50)) {
    const a = transcript.analyze(transcript.readRecent(file));
    if (!a.last || !isInScope(a.cwd)) continue;
    const s = upsertSession(file, a, false);
    if (!handledKeys.has(file)) handledKeys.set(file, `${a.last.uuid || a.lastAt}:${a.status}`);
    s.updatedAt = Math.max(s.updatedAt, mtime);
    if (!pending.has(s.id)) {
      s.status = a.status === 'done' ? 'done' : a.status === 'ask' ? 'attention' : (Date.now() - mtime < STALE_MS ? 'running' : 'idle');
    }
  }
  scheduleTreeRefresh();
}

/** Drop sessions (and all their timers/alerts) that no longer belong to this window's scope. */
function forgetSession(sid) {
  const s = sessions.get(sid);
  acknowledge(sid);
  clearMapTimer(fallbackTimers, `${sid}:done`);
  clearMapTimer(fallbackTimers, `${sid}:attention`);
  if (s?.file) { cancelPermissionCheck(s.file); handledKeys.delete(s.file); }
  sessions.delete(sid);
  lastAlert.delete(sid);
  hookedSessions.delete(sid);
}

/** Bound memory on long-running windows: forget old sessions nobody is waiting on. */
function pruneStale() {
  const since = Date.now() - (Number(cfg('sessions.recentHours')) || 24) * 3600 * 1000;
  for (const [sid, s] of [...sessions]) {
    if (s.updatedAt >= since || pending.has(sid) || terminalForSession(sid)) continue;
    forgetSession(sid);
  }
  claims.gc(CLAIMS_DIR);
  for (const [id, at] of childSessions) if (Date.now() - at > 3600 * 1000) childSessions.delete(id);
  if (fileScopeCache.size > 5000) fileScopeCache.clear();
  // A terminal launched with --session-id whose session never produced a transcript (Claude failed to
  // start, or the user hasn't typed yet): drop the placeholder so the tree stays clean and other
  // sessions in that terminal can bind. The id stays on the terminal and re-binds when it shows up.
  for (const info of terminalInfo.values()) {
    const s = info.sessionId && sessions.get(info.sessionId);
    if (!s || s.file || Date.now() - info.createdAt < PLACEHOLDER_TTL_MS || pending.has(s.id)) continue;
    info.sessionId = undefined;
    sessions.delete(s.id);
  }
  scheduleTreeRefresh();
}

function pruneOutOfScope() {
  fileScopeCache.clear();
  for (const [sid, s] of [...sessions]) {
    if (isInScope(s.cwd, s.terminalId)) continue;
    forgetSession(sid);
  }
}

function setupWatchers() {
  disposeWatchers();
  try { fs.mkdirSync(PROJECTS_DIR, { recursive: true }); } catch {}
  scanProjects();
  try {
    rootWatcher = fs.watch(PROJECTS_DIR, () => scanProjects(true));
    rootWatcher.on('error', () => {});
  } catch {}
  try {
    settingsWatcher = fs.watch(CLAUDE_DIR, (_e, name) => { if (name === 'settings.json') refreshHookState(); });
    settingsWatcher.on('error', () => {});
  } catch {}
  out.info(`Watching ${dirWatchers.size} project directories`);
}

function disposeWatchers() {
  for (const w of dirWatchers.values()) try { w.close(); } catch {}
  dirWatchers = new Map();
  for (const w of [rootWatcher, settingsWatcher]) try { w?.close(); } catch {}
  rootWatcher = settingsWatcher = null;
  stopEventsWatcher();
  pushService?.cancelAll();
  for (const m of [fileTimers, permTimers, fallbackTimers, claimTimers]) { for (const k of [...m.keys()]) clearMapTimer(m, k); }
}

// ── Hooks (precise mode) ─────────────────────────────────────────────────────

function readClaudeSettings() {
  try { return { ok: true, data: jsonFile.readJson(SETTINGS_FILE) }; } catch (e) { return { ok: false, data: {}, error: e }; }
}

function refreshHookState() {
  const prev = hookState;
  const cur = readClaudeSettings();
  if (!cur.ok) return; // keep the last known state while the file is mid-edit / invalid
  hookState = hooks.hooksStatus(cur.data, process.platform);
  if (prev !== hookState) out.info(`Hooks: ${hookState}`);
  if (hookState !== 'none') startEventsWatcher(); else stopEventsWatcher();
  vscode.commands.executeCommand('setContext', 'claudeTerminal.hooks', hookState);
}

async function installHooks(silent = false) {
  const cur = readClaudeSettings();
  if (!cur.ok) { vscode.window.showErrorMessage(cur.error.message); return; }
  refreshHookState();
  if (hookState === 'current') {
    if (!silent) vscode.window.showInformationMessage('Precise alerts are already enabled.');
    return;
  }
  if (!silent) {
    const ok = await vscode.window.showInformationMessage(
      'Enable precise alerts?',
      { modal: true, detail: `Adds ${hooks.HOOK_EVENTS.join(', ')} hooks to ${SETTINGS_FILE}. A backup is saved next to it and your other settings and hooks are kept.` },
      'Enable');
    if (ok !== 'Enable') return;
  }
  try {
    // Re-reads the file and re-applies the change, so edits made while the dialog was open are kept.
    const { backup } = jsonFile.updateJsonFileAtomic(SETTINGS_FILE, (data) => hooks.addHooks(data, process.platform));
    out.info(`Hooks installed${backup ? `; backup: ${backup}` : ''}`);
  } catch (e) {
    vscode.window.showErrorMessage(`Could not update ${SETTINGS_FILE}: ${e.message}`);
    return;
  }
  refreshHookState();
  vscode.window.showInformationMessage('Precise alerts enabled. Claude sessions that are already running pick them up after a restart; until then they keep using standard detection.');
}

async function uninstallHooks() {
  const cur = readClaudeSettings();
  if (!cur.ok) { vscode.window.showErrorMessage(cur.error.message); return; }
  if (hooks.hooksStatus(cur.data, process.platform) === 'none') {
    vscode.window.showInformationMessage('Precise alerts are not enabled.');
    return;
  }
  try {
    jsonFile.updateJsonFileAtomic(SETTINGS_FILE, (data) => hooks.removeHooks(data));
  } catch (e) {
    vscode.window.showErrorMessage(`Could not update ${SETTINGS_FILE}: ${e.message}`);
    return;
  }
  hookedSessions.clear();
  refreshHookState();
  vscode.window.showInformationMessage('Claude Terminal hooks removed.');
}

function startEventsWatcher() {
  if (eventsPoll) return;
  try { fs.mkdirSync(EVENTS_DIR, { recursive: true }); } catch {}
  // Don't replay events that happened before this window started
  try { for (const n of fs.readdirSync(EVENTS_DIR)) seenEvents.add(n); } catch {}
  try {
    eventsWatcher = fs.watch(EVENTS_DIR, () => {
      clearTimeout(eventsScanTimer);
      eventsScanTimer = setTimeout(scanEvents, 50);
    });
    eventsWatcher.on('error', () => {});
  } catch {}
  eventsPoll = setInterval(scanEvents, EVENTS_POLL_MS); // fs.watch is unreliable on some file systems
}

function stopEventsWatcher() {
  try { eventsWatcher?.close(); } catch {}
  eventsWatcher = null;
  clearInterval(eventsPoll);
  eventsPoll = null;
  clearTimeout(eventsScanTimer);
}

function scanEvents() {
  let names;
  try { names = fs.readdirSync(EVENTS_DIR); } catch { return; }
  const now = Date.now();
  const fresh = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const file = path.join(EVENTS_DIR, n);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (now - st.mtimeMs > EVENT_TTL_MS) { try { fs.unlinkSync(file); } catch {} seenEvents.delete(n); continue; }
    if (!seenEvents.has(n)) fresh.push({ n, file, t: st.mtimeMs });
  }
  for (const n of [...seenEvents]) if (!names.includes(n)) seenEvents.delete(n);
  fresh.sort((a, b) => a.t - b.t || a.n.localeCompare(b.n));
  for (const { n, file } of fresh) {
    seenEvents.add(n);
    let parsed = null;
    try { parsed = hooks.parseHookLine(fs.readFileSync(file, 'utf-8').trim()); } catch {}
    if (parsed) {
      try { handleHookEvent(parsed.tid, parsed.event, n); } catch (e) { out.error(`Hook event failed: ${e.message}`); }
    }
  }
}

function sessionForHook(ev) {
  const id = ev.session_id;
  if (!id) return null;
  let s = sessions.get(id);
  if (!s) {
    s = { id, status: 'idle', updatedAt: Date.now(), cwd: ev.cwd, file: ev.transcript_path };
    sessions.set(id, s);
  }
  if (ev.cwd) s.cwd = ev.cwd;
  if (ev.transcript_path) s.file = ev.transcript_path;
  return s;
}

/** Sessions launched *inside* another Claude session (e.g. `claude -p` run by a tool). id -> first seen. */
const childSessions = new Map();

function transcriptEntrypoint(file) {
  if (!file) return null;
  const e = transcript.readHead(file, 16 * 1024).find((x) => x.entrypoint);
  return e ? e.entrypoint : null;
}

/**
 * Another session id reported on a terminal that is exactly bound to a different session.
 * Decided only on evidence, never on our (possibly stale) idea of the bound session's state:
 *  - 'switch' – /clear, /resume, or an interactive Claude restarted in the same terminal → re-bind
 *  - 'nested' – the transcript says `claude -p` / SDK (a tool ran Claude) → ignore
 *  - 'unknown' – no transcript yet → don't re-bind, but still alert normally (never silence)
 */
function classifyOtherSession(tid, s, ev) {
  const t = terminalsById.get(tid);
  const boundId = t && terminalInfo.get(t)?.sessionId;
  const bound = boundId && sessions.get(boundId);
  if (!boundId || boundId === s.id || !bound?.bindExact) return 'switch';
  if (!bound.file) return 'switch'; // the bound session never produced a transcript (placeholder)
  if (ev.hook_event_name === 'SessionStart' && ['clear', 'resume', 'compact'].includes(ev.source)) return 'switch';
  const ep = transcriptEntrypoint(ev.transcript_path || s.file);
  if (!ep) return 'unknown';
  return /^sdk/i.test(ep) ? 'nested' : 'switch';
}

/** @param {string} eventKey the event file name — identical in every window, used for cross-window de-dup */
function handleHookEvent(tid, ev, eventKey = '') {
  if (!ev || typeof ev !== 'object' || !isInScope(ev.cwd, tid)) return;
  if (childSessions.has(ev.session_id)) return;
  const s = sessionForHook(ev);
  if (!s) return;
  hookedSessions.add(s.id);
  const ours = !!tid && terminalsById.has(tid);
  if (ours && (s.terminalId !== tid || !s.bindExact)) {
    const verdict = classifyOtherSession(tid, s, ev);
    if (verdict === 'nested') {
      childSessions.set(s.id, Date.now());
      sessions.delete(s.id);
      out.debug('Ignoring hook event from a nested claude -p run');
      return;
    }
    if (verdict === 'switch') bindSession(s.id, tid, true);
  }
  // Started in a Claude terminal of another VS Code window: that window makes the noise.
  const foreign = !!tid && !ours;
  const dedupKey = `hook:${eventKey || `${s.id}:${ev.hook_event_name}:${Date.now()}`}`;
  const project = projectName(ev.cwd);
  out.info(`Hook ${ev.hook_event_name}${ev.notification_type ? '/' + ev.notification_type : ''}${project ? ` · ${project}` : ''}`);

  switch (ev.hook_event_name) {
    case 'SessionStart':
      s.status = 'idle';
      s.updatedAt = Date.now();
      break;
    case 'UserPromptSubmit':
      s.status = 'running';
      s.promptAt = Date.now();
      s.updatedAt = Date.now();
      if (ev.prompt && !s.title) s.title = util.summarize(ev.prompt, 70);
      acknowledge(s.id);
      break;
    case 'Stop': {
      if (ev.stop_hook_active) break;
      // Transcript detection may already have reported this turn (e.g. window opened mid-session)
      if (alreadyAlerted(s.id, 'done', Math.max(Date.now() - 15000, s.promptAt || 0, s.activityAt || 0))) break;
      let message = '';
      if (s.file) message = transcript.analyze(transcript.readRecent(s.file)).message;
      raiseAlert('done', s.id, { message, project, durationMs: s.promptAt ? Date.now() - s.promptAt : undefined, dedupKey, foreign });
      break;
    }
    case 'Notification': {
      const type = ev.notification_type || '';
      if (type === 'idle_prompt' || type === 'auth_success') break;
      if (alreadyAlerted(s.id, 'attention', Math.max(Date.now() - 15000, s.promptAt || 0, s.activityAt || 0))) break;
      // Claude's message is generic ("Claude needs your permission"); name the actual tool call when we can
      let message = util.summarize(ev.message || 'Claude needs your attention');
      if (type === 'permission_prompt' && s.file) {
        const a = transcript.analyze(transcript.readRecent(s.file));
        if (a.status === 'tool' && a.toolBlocks[0]) message = 'Permission needed — ' + transcript.describeTool(a.toolBlocks[0]);
      }
      raiseAlert('attention', s.id, { message, project, dedupKey, foreign });
      break;
    }
  }
  scheduleTreeRefresh();
}

function scheduleTreeRefresh() {
  treeProvider?.refresh();
}

// ── Commands: sounds / DND / push ────────────────────────────────────────────

function updateDnd() {
  const dnd = isDnd();
  const quietNow = util.inQuietHours(cfg('notification.quietHours'));
  dndItem.text = dnd ? '$(bell-slash)' : quietNow ? '$(bell-slash-dot)' : '$(bell)';
  dndItem.tooltip = dnd ? 'Claude alerts muted — click to unmute' : quietNow ? 'Quiet hours — sounds muted' : 'Claude alerts on — click to mute';
  if (cfg('notification.showDndToggle')) dndItem.show(); else dndItem.hide();
}

async function toggleDnd() {
  const next = !isDnd();
  await ctx.globalState.update('dnd', next);
  if (next) { pushService.cancelAll(); clearTimeout(repeatTimer); }
  updateDnd();
  vscode.window.setStatusBarMessage(next ? '$(bell-slash) Claude alerts muted' : '$(bell) Claude alerts on', 2500);
}

async function testAlert() {
  const kind = await soundPicker.pickKind('Preview which alert? (sound, speech, desktop notification and push — as configured)');
  if (!kind) return;
  playSound(kind, true);
  const title = kind === 'done' ? 'Claude finished (test)' : 'Claude needs your input (test)';
  if (cfg('sound.speak')) setTimeout(() => run(sound.buildSpeakCommand(process.platform, title), 'Speech'), 600);
  if (cfg('notification.systemNotification')) run(sound.buildSystemNotificationCommand(process.platform, title, 'This is a test alert'), 'System notification');
  await pushService.sendTest(kind, title);
}

async function maybeOnboard() {
  refreshHookState();
  if (hookState === 'outdated') {
    const a = await vscode.window.showInformationMessage('Claude Terminal: your precise-alert hooks are from an older version.', 'Update', 'Remove');
    if (a === 'Update') await installHooks(true);
    else if (a === 'Remove') await uninstallHooks();
    return;
  }
  if (hookState !== 'none' || ctx.globalState.get('onboarded')) return;
  await ctx.globalState.update('onboarded', true);
  const a = await vscode.window.showInformationMessage(
    'Claude Terminal: enable precise alerts? It detects permission prompts exactly and knows which tab to jump to (adds hooks to ~/.claude/settings.json).',
    'Enable', 'Not now');
  if (a === 'Enable') await installHooks(true);
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

function activate(context) {
  ctx = context;
  out = vscode.window.createOutputChannel('Claude Terminal', { log: true });
  usage = new UsageStatus(PROJECTS_DIR, cfg, out);
  pushService = new PushService(context, cfg, out, { muted: pushMuted, userAtVsCode });

  bellItem = vscode.window.createStatusBarItem('claudeTerminal.bell', vscode.StatusBarAlignment.Right, 1000);
  bellItem.name = 'Claude Alerts';
  bellItem.command = 'claude-terminal.focusClaude';
  dndItem = vscode.window.createStatusBarItem('claudeTerminal.dnd', vscode.StatusBarAlignment.Right, 999);
  dndItem.name = 'Claude Do Not Disturb';
  dndItem.command = 'claude-terminal.toggleDnd';
  context.subscriptions.push(out, bellItem, dndItem, usage, pushService);

  treeProvider = new SessionsProvider({
    sessions,
    isPending: (id) => pending.has(id),
    isLive: (id) => !!terminalForSession(id),
    recentHours: () => Number(cfg('sessions.recentHours')) || 24,
  });
  context.subscriptions.push(treeProvider);
  treeView = vscode.window.createTreeView('claudeTerminal.sessions', { treeDataProvider: treeProvider });
  context.subscriptions.push(treeView);

  // Re-adopt terminals that survived a window reload
  const saved = context.workspaceState.get('sessionTerminals', {});
  for (const t of vscode.window.terminals) {
    const id = t.creationOptions?.env?.[ENV_TID];
    if (id) adoptTerminal(t, id, t.creationOptions.cwd?.fsPath || t.creationOptions.cwd, 0, t.creationOptions.env?.[ENV_SID]);
  }

  setupWatchers();
  refreshHookState();
  loadRecentSessions();
  for (const sid of Object.keys(saved)) {
    const b = storedBinding(sid);
    if (b && terminalsById.has(b.tid) && sessions.has(sid)) bindSession(sid, b.tid, b.exact);
  }
  updateDnd();
  usage.update(true);
  tickTimer = setInterval(() => { usage.update(); updateDnd(); pruneStale(); }, 30 * 1000);
  stampFocus();
  focusTimer = setInterval(stampFocus, FOCUS_STAMP_MS);

  migrateV1Settings().catch((e) => out.warn(`Settings migration: ${e.message}`));
  const loadSecrets = () => pushService.load().catch((e) => out.error(`Secrets: ${e.message}`));
  loadSecrets();
  context.subscriptions.push(context.secrets.onDidChange(loadSecrets));

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('claude-terminal.open', openOrFocus);
  reg('claude-terminal.newSession', () => createClaudeTerminal());
  reg('claude-terminal.continue', () => createClaudeTerminal({ args: ['--continue'] }));
  reg('claude-terminal.resume', () => createClaudeTerminal({ args: ['--resume'] }));
  reg('claude-terminal.focusClaude', jumpToClaude);
  reg('claude-terminal.openSession', (arg) => openSession(typeof arg === 'string' ? arg : arg?.id));
  reg('claude-terminal.resumeSession', (s) => s && openSession(s.id));
  reg('claude-terminal.copySessionId', (s) => s && vscode.env.clipboard.writeText(s.id));
  reg('claude-terminal.revealTranscript', (s) => s?.file && vscode.window.showTextDocument(vscode.Uri.file(s.file), { preview: true }));
  reg('claude-terminal.refreshSessions', () => { loadRecentSessions(); treeProvider.refresh(); });
  reg('claude-terminal.sendSelection', sendSelection);
  reg('claude-terminal.sendFile', sendFiles);
  reg('claude-terminal.toggleDnd', toggleDnd);
  reg('claude-terminal.testSound', testAlert);
  reg('claude-terminal.chooseSound', () => soundPicker.chooseSound({ cfg, run, play: (kind) => playSound(kind, true) }));
  reg('claude-terminal.setupPush', () => pushService.setup());
  reg('claude-terminal.installHooks', () => installHooks(false));
  reg('claude-terminal.uninstallHooks', uninstallHooks);
  reg('claude-terminal.clearAlerts', clearAlerts);
  reg('claude-terminal.refreshUsage', () => usage.update(true));
  reg('claude-terminal.showLog', () => out.show());

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal((t) => {
      if (t && terminalInfo.has(t)) {
        lastActiveTerminal = t;
        if (vscode.window.state.focused) acknowledgeTerminal(t);
      }
    }),
    vscode.window.onDidChangeWindowState((st) => {
      stampFocus();
      const t = vscode.window.activeTerminal;
      const sid = t && terminalInfo.get(t)?.sessionId;
      if (st.focused && sid && isLookingAt(sid)) acknowledge(sid);
    }),
    vscode.window.onDidCloseTerminal((t) => {
      const info = terminalInfo.get(t);
      if (info) {
        terminalsById.delete(info.id);
        terminalInfo.delete(t);
        if (info.sessionId) {
          const s = sessions.get(info.sessionId);
          if (s) { s.terminalId = undefined; if (s.status === 'running') s.status = 'idle'; }
          acknowledge(info.sessionId);
        }
      }
      if (lastActiveTerminal === t) lastActiveTerminal = null;
      scheduleTreeRefresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('claudeTerminal')) return;
      updateDnd(); updateBell(); usage.update(true);
      if (e.affectsConfiguration('claudeTerminal.notification.scope') || e.affectsConfiguration('claudeTerminal.sessions')) {
        pruneOutOfScope();
        loadRecentSessions();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { pruneOutOfScope(); loadRecentSessions(); }),
    { dispose: () => { disposeWatchers(); clearInterval(tickTimer); clearInterval(focusTimer); clearTimeout(repeatTimer); } },
  );

  setTimeout(() => maybeOnboard().catch((e) => out.error(String(e))), 3000);
  out.info(`Activated (hooks: ${hookState})`);

  // Read-only snapshot for diagnostics and end-to-end tests.
  return {
    state: () => ({
      hookState,
      pending: Object.fromEntries(pending),
      lastAlert: Object.fromEntries(lastAlert),
      hookedSessions: [...hookedSessions],
      sessions: [...sessions.values()].map((s) => ({ id: s.id, status: s.status, terminalId: s.terminalId, bindExact: !!s.bindExact, cwd: s.cwd, message: s.message })),
    }),
  };
}

function deactivate() {
  disposeWatchers();
  clearInterval(tickTimer);
  clearInterval(focusTimer);
  clearTimeout(repeatTimer);
}

module.exports = { activate, deactivate };
