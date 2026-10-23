// End-to-end tests of src/extension.js against a mocked vscode API and a temporary HOME.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

if (process.platform === 'win32') { test('skipped on Windows', () => {}); return; }

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-home-'));
process.env.HOME = HOME;
const WS = path.join(HOME, 'work', 'proj');
const WS2 = path.join(HOME, 'work', 'other');
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(WS2, { recursive: true });
const projDir = (cwd) => path.join(HOME, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
const SETTINGS = path.join(HOME, '.claude', 'settings.json');

// ── vscode mock ──
const calls = { exec: [], messages: [], fetch: [], clipboard: '' };
const settings = {
  'notification.scope': 'workspace', 'notification.onDone': true, 'notification.onAttention': true,
  'notification.suppressWhenFocused': true, 'notification.systemNotification': true, 'notification.showBell': true,
  'notification.showDetails': true, 'notification.detectPermissionPrompts': true, 'notification.permissionDelaySeconds': 2,
  'notification.minDurationSeconds': 0, 'notification.quietHours': '', 'notification.showDndToggle': true,
  'sound.volume': 50, 'sound.done.name': 'Glass', 'sound.attention.name': 'Ping', 'sound.repeatAttentionSeconds': 0,
  'terminal.command': 'claude', 'terminal.args': '', 'terminal.location': 'editor', 'terminal.openToSide': true, 'terminal.reuseExisting': true,
  'sessions.recentHours': 24, 'usage.showInStatusBar': true, 'usage.showCost': true, 'usage.customPricing': {},
  'push.provider': 'none', 'push.delaySeconds': 1, 'push.onlyWhenAway': true, 'push.onDone': true, 'push.onAttention': true,
  'push.respectQuietHours': true, 'push.content': 'generic', 'push.ntfyServer': 'https://ntfy.sh',
  // a 1.3.1 user who had turned sounds off (and set nothing for the new key)
  'notification.sound': false,
};
const REGISTERED = new Set(require('../package.json').contributes.configuration.flatMap((c) => Object.keys(c.properties)).map((k) => k.replace('claudeTerminal.', '')));
const DEFAULTS = Object.fromEntries(require('../package.json').contributes.configuration.flatMap((c) => Object.entries(c.properties)).map(([k, v]) => [k.replace('claudeTerminal.', ''), v.default]));
const statusItems = {};
const terminals = [];
const commands = {};
const state = {};
const secretStore = new Map([['push.webhookUrl', 'https://hooks.example/secret']]);
class EventEmitter { constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; } fire(v) { this.l.forEach((f) => f(v)); } }
const onActiveTerminal = new EventEmitter();
const onFoldersChanged = new EventEmitter();
let nextAnswer;
const answer = async (...a) => { calls.messages.push(String(a[0])); const v = nextAnswer; nextAnswer = undefined; return v; };
const vscode = {
  EventEmitter, StatusBarAlignment: { Right: 2 }, TerminalLocation: { Editor: 2, Panel: 1 }, ViewColumn: { Beside: -2 },
  TreeItemCollapsibleState: { None: 0 }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ThemeColor: class { constructor(id) { this.id = id; } }, ThemeIcon: class { constructor(id) { this.id = id; } },
  MarkdownString: class { constructor(v = '') { this.value = v; } appendMarkdown(s) { this.value += s; return this; } appendText(s) { this.value += s; return this; } },
  TreeItem: class { constructor(label) { this.label = label; } },
  TabInputTerminal: class {},
  Uri: { joinPath: (...p) => p.join('/'), file: (f) => ({ fsPath: f, scheme: 'file' }) },
  env: { clipboard: { writeText: async (t) => { calls.clipboard = t; } } },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: WS } }],
    getConfiguration: (section) => {
      const pre = section === 'claudeTerminal' ? '' : section.replace('claudeTerminal.', '') + '.';
      return {
        get: (k) => (pre + k in settings ? settings[pre + k] : DEFAULTS[pre + k]),
        inspect: (k) => (pre + k in settings ? { globalValue: settings[pre + k] } : {}),
        update: async (k, v) => {
          if (!REGISTERED.has(pre + k)) throw new Error(`Unable to write to User Settings because claudeTerminal.${pre + k} is not a registered configuration.`);
          if (v === undefined) delete settings[pre + k]; else settings[pre + k] = v;
        },
      };
    },
    getWorkspaceFolder: () => ({ uri: { fsPath: WS } }),
    asRelativePath: (u) => path.relative(WS, u.fsPath),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidChangeWorkspaceFolders: onFoldersChanged.event,
  },
  window: {
    state: { focused: false },
    terminals,
    activeTerminal: undefined,
    activeTextEditor: undefined,
    tabGroups: { all: [], activeTabGroup: { activeTab: undefined } },
    createOutputChannel: () => ({ info(m) { if (process.env.CT_DEBUG) console.log('[log]', m); }, warn(m) { if (process.env.CT_DEBUG) console.log('[warn]', m); }, error(m) { if (process.env.CT_DEBUG) console.log('[err]', m); }, debug() {}, show() {}, dispose() {} }),
    createStatusBarItem: (id) => (statusItems[id] = { id, visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }),
    createTreeView: (_id, { treeDataProvider }) => ({ provider: treeDataProvider, dispose() {} }),
    createTerminal: (opts) => {
      const t = { name: opts.name, creationOptions: opts, sent: [], sendText(s) { this.sent.push(s); }, show() { vscode.window.activeTerminal = t; onActiveTerminal.fire(t); } };
      terminals.push(t);
      return t;
    },
    onDidChangeActiveTerminal: onActiveTerminal.event,
    onDidChangeWindowState: () => ({ dispose() {} }),
    onDidCloseTerminal: () => ({ dispose() {} }),
    showInformationMessage: answer, showWarningMessage: answer, showErrorMessage: answer,
    setStatusBarMessage: () => {},
  },
  commands: { registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; }, executeCommand: async () => {} },
};

const cp = require('child_process');
const realExec = cp.exec;
cp.exec = (cmd, opts, cb) => {
  if (typeof cmd === 'string' && /^(afplay|osascript|say|paplay|notify-send|powershell)/.test(cmd)) { calls.exec.push(cmd); (typeof opts === 'function' ? opts : cb)?.(null); return; }
  return realExec(cmd, opts, cb);
};
globalThis.fetch = async (url, init) => { calls.fetch.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, text: async () => '' }; };
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest); };

const ext = require('../src/extension');
const hooks = require('../src/hooks');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const entry = (sid, cwd, o) => JSON.stringify({ sessionId: sid, cwd, timestamp: new Date().toISOString(), uuid: `u${++n}`, ...o });
const append = (sid, cwd, ...entries) => {
  fs.mkdirSync(projDir(cwd), { recursive: true });
  fs.appendFileSync(path.join(projDir(cwd), `${sid}.jsonl`), entries.map((e) => entry(sid, cwd, e)).join('\n') + '\n');
};
const prompt = (text, extra = {}) => ({ type: 'user', message: { role: 'user', content: text }, ...extra });
const done = (text = 'ok') => ({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const toolUse = (name, input) => ({ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] } });
const toolResult = () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
const sidOf = (term) => /--session-id (\S+)/.exec(term.sent[0])[1];
const claimCount = () => { try { return fs.readdirSync(path.join(HOME, '.claude', 'claude-terminal-state', 'claims')).length; } catch { return 0; } };
const sounds = () => calls.exec.filter((c) => c.startsWith('afplay'));
const fireHook = (tid, ev) => cp.execSync(hooks.hookCommand(process.platform), {
  input: JSON.stringify({ cwd: WS, ...ev }), env: { ...process.env, CLAUDE_TERMINAL_ID: tid }, shell: '/bin/sh',
});
const lookAt = (t) => {
  vscode.window.state.focused = true;
  vscode.window.activeTerminal = t;
  vscode.window.tabGroups.activeTabGroup.activeTab = { input: new vscode.TabInputTerminal(), label: t.name };
};
const lookAway = () => {
  vscode.window.state.focused = false;
  vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
};

test('end to end', async (t) => {
  fs.mkdirSync(path.join(HOME, '.claude', 'projects'), { recursive: true });
  ext.activate({
    subscriptions: { push() {} }, extensionUri: '/ext',
    globalState: { get: (k, d) => (k in state ? state[k] : d), update: async (k, v) => { state[k] = v; } },
    workspaceState: { get: (k, d) => (('ws.' + k) in state ? state['ws.' + k] : d), update: async (k, v) => { state['ws.' + k] = v; } },
    secrets: {
      get: async (k) => secretStore.get(k), store: async (k, v) => { secretStore.set(k, v); }, delete: async (k) => { secretStore.delete(k); },
      onDidChange: () => ({ dispose() {} }),
    },
  });
  await wait(100);

  await t.test('1.3.1 users who turned sounds off stay muted', () => {
    assert.strictEqual(settings['sound.enabled'], false);
    settings['sound.enabled'] = true; // the rest of the suite needs sound
  });

  let t1;
  let S1;
  await t.test('opens a terminal with a tracking id and reuses it', async () => {
    await commands['claude-terminal.open']();
    t1 = terminals[0];
    assert.match(t1.creationOptions.env.CLAUDE_TERMINAL_ID, /^ct-/);
    assert.match(t1.sent[0], /^claude --session-id [0-9a-f-]{36}$/);
    S1 = sidOf(t1);
    await commands['claude-terminal.open']();
    assert.strictEqual(terminals.length, 1);
    lookAway();
  });

  await t.test('done alert with duration; desktop notification when unfocused', async () => {
    append(S1, WS, prompt('refactor auth', { timestamp: new Date(Date.now() - 95000).toISOString() }));
    append(S1, WS, done('Refactor complete.'), { type: 'last-prompt' });
    await wait(1300);
    assert.strictEqual(sounds().length, 1);
    const notif = calls.exec.find((c) => c.startsWith('osascript'));
    assert.match(notif, /proj \(1m 3\ds\)/);
    assert.ok(statusItems['claudeTerminal.bell'].visible);
  });

  await t.test('jump goes to the bound terminal and clears the alert', async () => {
    vscode.window.state.focused = true;
    await commands['claude-terminal.focusClaude']();
    assert.strictEqual(vscode.window.activeTerminal, t1);
    assert.ok(!statusItems['claudeTerminal.bell'].visible);
    lookAway();
  });

  await t.test('metadata lines do not re-trigger', async () => {
    const before = sounds().length;
    append(S1, WS, { type: 'permission-mode', permissionMode: 'default' });
    await wait(1200);
    assert.strictEqual(sounds().length, before);
  });

  await t.test('suppressed while looking at that exact session (and other windows stay quiet)', async () => {
    lookAt(t1);
    const before = sounds().length;
    const claimsBefore = claimCount();
    append(S1, WS, prompt('again'), done('ok'));
    await wait(1300);
    assert.strictEqual(sounds().length, before);
    assert.strictEqual(claimCount(), claimsBefore + 1, 'suppressed alert is still claimed, so no other window beeps');
    lookAway();
  });

  await t.test('looking at a different Claude terminal does NOT suppress', async () => {
    await commands['claude-terminal.newSession']();
    const t2 = terminals[1];
    append(sidOf(t2), WS, prompt('task two'));
    await wait(1200);
    lookAt(t2);
    const before = sounds().length;
    append(S1, WS, prompt('third'), done('ok'));
    await wait(1300);
    assert.strictEqual(sounds().length, before + 1);
    vscode.window.state.focused = true;
    await commands['claude-terminal.focusClaude']();
    lookAway();
  });

  await t.test('auto-allowed tool is quiet; risky tool alerts even if metadata arrives meanwhile', async () => {
    const before = sounds().length;
    append(S1, WS, prompt('read it'), toolUse('Read', { file_path: path.join(WS, 'a.js') }));
    await wait(3800);
    assert.strictEqual(sounds().length, before, 'Read inside workspace is auto-allowed');
    append(S1, WS, toolResult(), toolUse('Bash', { command: 'rm -rf dist' }));
    await wait(1200);
    append(S1, WS, { type: 'permission-mode', permissionMode: 'default' }); // must not cancel the pending check
    await wait(2500);
    assert.strictEqual(sounds().length, before + 1);
    assert.match(sounds().at(-1), /Ping/);
  });

  await t.test('tool result acknowledges the alert', async () => {
    append(S1, WS, toolResult());
    await wait(1200);
    assert.ok(!statusItems['claudeTerminal.bell'].visible);
  });

  await t.test('sessions outside the workspace are ignored', async () => {
    const before = sounds().length;
    append('X', '/elsewhere', prompt('x'), done('x'));
    await wait(1300);
    assert.strictEqual(sounds().length, before);
  });

  await t.test('push: generic content, and muting cancels a scheduled push', async () => {
    settings['push.provider'] = 'webhook';
    append(S1, WS, prompt('push me'), done('secret summary'));
    await wait(2500);
    assert.strictEqual(calls.fetch.length, 1);
    assert.strictEqual(calls.fetch[0].url, 'https://hooks.example/secret', 'credentials come from secure storage');
    assert.ok(!JSON.stringify(calls.fetch[0].body).includes('secret summary'), 'no details by default');
    assert.ok(!JSON.stringify(calls.fetch[0].body).includes('proj'), 'no project name by default');

    append(S1, WS, prompt('again'), done('again'));
    await wait(1000); // alert raised, push scheduled for +1s
    await commands['claude-terminal.toggleDnd']();
    await wait(1500);
    assert.strictEqual(calls.fetch.length, 1, 'muted before send → no push');
    await commands['claude-terminal.toggleDnd']();
    settings['push.provider'] = 'none';
    await commands['claude-terminal.clearAlerts']();
  });

  await t.test('cancelling a resume keeps the alert', async () => {
    append('R1', WS, prompt('in another window'), toolUse('AskUserQuestion', { questions: [{ question: 'Which DB?' }] }));
    await wait(1900);
    assert.ok(statusItems['claudeTerminal.bell'].visible);
    const before = terminals.length;
    nextAnswer = undefined; // user dismisses "Resume Anyway"
    await commands['claude-terminal.openSession']('R1');
    assert.strictEqual(terminals.length, before);
    assert.ok(statusItems['claudeTerminal.bell'].visible, 'still pending');
    await commands['claude-terminal.clearAlerts']();
  });

  await t.test('hooks configured but this session never ran them → transcript still alerts', async () => {
    fs.writeFileSync(SETTINGS, JSON.stringify(hooks.addHooks({ env: { KEEP: '1' } }, process.platform)));
    await wait(500);
    await commands['claude-terminal.installHooks']();
    assert.ok(calls.messages.some((m) => /already enabled/.test(m)), 'hook state picked up from settings.json');
    const before = sounds().length;
    append('OLD', WS, prompt('started before hooks'), done('fine'));
    await wait(1900);
    assert.strictEqual(sounds().length, before + 1);
  });

  let t3;
  await t.test('hooked session: Stop hook + transcript produce exactly one alert', async () => {
    await commands['claude-terminal.newSession']();
    t3 = terminals.at(-1);
    const tid = t3.creationOptions.env.CLAUDE_TERMINAL_ID;
    lookAt(t1);
    fireHook(tid, { hook_event_name: 'SessionStart', session_id: 'H1' });
    fireHook(tid, { hook_event_name: 'UserPromptSubmit', session_id: 'H1', prompt: 'deploy' });
    await wait(1600); // outside the sound de-bounce window of the previous test
    const before = sounds().length;
    append('H1', WS, prompt('deploy'), done('Deployed.'));
    fireHook(tid, { hook_event_name: 'Stop', session_id: 'H1' });
    await wait(6500); // longer than the hook grace period
    assert.strictEqual(sounds().length, before + 1);
  });

  await t.test('hook binds the exact terminal; jump goes there', async () => {
    vscode.window.state.focused = true;
    await commands['claude-terminal.focusClaude']();
    assert.strictEqual(vscode.window.activeTerminal, t3);
    lookAway();
  });

  await t.test('hooked session whose Stop hook never arrives → transcript fallback fires once', async () => {
    const tid = t3.creationOptions.env.CLAUDE_TERMINAL_ID;
    fireHook(tid, { hook_event_name: 'UserPromptSubmit', session_id: 'H1', prompt: 'next' });
    await wait(400);
    const before = sounds().length;
    append('H1', WS, prompt('next'), done('Done again.'));
    await wait(2000);
    assert.strictEqual(sounds().length, before, 'waits for the hook first');
    await wait(5000);
    assert.strictEqual(sounds().length, before + 1);
  });

  await t.test('permission Notification hook alerts', async () => {
    const tid = t3.creationOptions.env.CLAUDE_TERMINAL_ID;
    fireHook(tid, { hook_event_name: 'UserPromptSubmit', session_id: 'H1', prompt: 'rm' });
    await wait(300);
    const before = sounds().length;
    fireHook(tid, { hook_event_name: 'Notification', session_id: 'H1', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    await wait(600);
    assert.strictEqual(sounds().length, before + 1);
    assert.match(sounds().at(-1), /Ping/);
    await commands['claude-terminal.clearAlerts']();
  });

  await t.test('nested claude run inheriting the terminal id is ignored and keeps the binding', async () => {
    const tid = t3.creationOptions.env.CLAUDE_TERMINAL_ID;
    await wait(1600);
    fireHook(tid, { hook_event_name: 'UserPromptSubmit', session_id: 'H1', prompt: 'run a script' });
    await wait(300);
    const before = sounds().length;
    const childFile = path.join(projDir(WS), 'CHILD.jsonl');
    fs.writeFileSync(childFile, entry('CHILD', WS, { ...prompt('q'), entrypoint: 'sdk-cli' }) + '\n');
    fireHook(tid, { hook_event_name: 'SessionStart', session_id: 'CHILD', source: 'startup', transcript_path: childFile });
    fireHook(tid, { hook_event_name: 'Stop', session_id: 'CHILD', transcript_path: childFile });
    await wait(4000);
    assert.strictEqual(sounds().length, before, 'no "finished" for the nested run');
    fireHook(tid, { hook_event_name: 'Stop', session_id: 'H1' });
    await wait(4000);
    assert.strictEqual(sounds().length, before + 1, 'parent still alerts');
    vscode.window.state.focused = true;
    await commands['claude-terminal.focusClaude']();
    assert.strictEqual(vscode.window.activeTerminal, t3, 'binding intact');
    lookAway();
  });

  await t.test('stale "running" state + interactive restart in the same terminal is NOT treated as nested', async () => {
    const tid = t3.creationOptions.env.CLAUDE_TERMINAL_ID;
    await wait(1600);
    fireHook(tid, { hook_event_name: 'UserPromptSubmit', session_id: 'H1', prompt: 'then Ctrl+C twice' }); // H1 stuck "running"
    await wait(300);
    const f = path.join(projDir(WS), 'RESTART.jsonl');
    fireHook(tid, { hook_event_name: 'SessionStart', session_id: 'RESTART', source: 'startup', transcript_path: f });
    fs.writeFileSync(f, entry('RESTART', WS, { ...prompt('new work'), entrypoint: 'cli' }) + '\n');
    fireHook(tid, { hook_event_name: 'UserPromptSubmit', session_id: 'RESTART', prompt: 'new work', transcript_path: f });
    await wait(300);
    const before = sounds().length;
    fireHook(tid, { hook_event_name: 'Stop', session_id: 'RESTART', transcript_path: f });
    await wait(4000);
    assert.strictEqual(sounds().length, before + 1, 'restarted session alerts');
    vscode.window.state.focused = true;
    await commands['claude-terminal.focusClaude']();
    assert.strictEqual(vscode.window.activeTerminal, t3, 're-bound to the terminal');
    lookAway();
  });

  await t.test('user responding during the non-owner delay cancels the alert', async () => {
    await commands['claude-terminal.clearAlerts']();
    await wait(1600);
    const before = sounds().length;
    fireHook('', { hook_event_name: 'Stop', session_id: 'QUICK' });
    await wait(150);
    fireHook('', { hook_event_name: 'UserPromptSubmit', session_id: 'QUICK', prompt: 'next' });
    await wait(4000);
    assert.strictEqual(sounds().length, before);
    assert.ok(!statusItems['claudeTerminal.bell'].visible);
  });

  await t.test('claude -p / SDK transcripts never alert', async () => {
    const before = sounds().length;
    append('SDK1', WS, { ...prompt('q'), entrypoint: 'sdk-cli' }, { ...done('a'), entrypoint: 'sdk-cli' });
    await wait(1900);
    assert.strictEqual(sounds().length, before);
  });

  await t.test('send selection: relative to the Claude terminal cwd', async () => {
    vscode.window.activeTextEditor = {
      document: { uri: { fsPath: path.join(WS, 'src', 'a.ts'), scheme: 'file' } },
      selections: [{ isEmpty: false, start: { line: 9, character: 0 }, end: { line: 20, character: 0 } }],
    };
    await commands['claude-terminal.sendSelection']();
    assert.strictEqual(vscode.window.activeTerminal.sent.at(-1), '@src/a.ts#L10-20 ');
  });

  await t.test('workspace change drops out-of-scope sessions and their alerts', async () => {
    append('S9', WS, prompt('p'), done('d'));
    await wait(1900);
    assert.ok(statusItems['claudeTerminal.bell'].visible);
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: WS2 } }];
    onFoldersChanged.fire();
    assert.ok(!statusItems['claudeTerminal.bell'].visible);
    const before = sounds().length;
    append('S9', WS, prompt('p2'), done('d2'));
    await wait(1300);
    assert.strictEqual(sounds().length, before);
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: WS } }];
  });

  await t.test('two candidate terminals: no guessed binding, no wrong suppression/acknowledge', async () => {
    for (const x of terminals.splice(0)) void x; // simulate closing all terminals
    vscode.window.terminals = terminals;
    await commands['claude-terminal.newSession']();
    await commands['claude-terminal.newSession']();
    const [A, B] = terminals;
    assert.notStrictEqual(A.name, B.name, 'unique names');
    append('AMB', WS, prompt('typed in A'));
    await wait(1200);
    lookAt(B);
    const before = sounds().length;
    append('AMB', WS, done('from A'));
    await wait(1900);
    assert.strictEqual(sounds().length, before + 1, 'not suppressed by looking at B');
    onActiveTerminal.fire(B);
    assert.ok(statusItems['claudeTerminal.bell'].visible, 'focusing B does not acknowledge A');
    lookAway();
    await commands['claude-terminal.clearAlerts']();
  });

  await t.test('panel mode never suppresses', async () => {
    await wait(1600); // leave the previous test's sound de-bounce window
    settings['terminal.location'] = 'panel';
    lookAt(terminals[0]);
    const before = sounds().length;
    append('AMB', WS, prompt('x'), done('y'));
    await wait(1900);
    assert.strictEqual(sounds().length, before + 1);
    settings['terminal.location'] = 'editor';
    lookAway();
    await commands['claude-terminal.clearAlerts']();
  });

  await t.test('stale transcripts never alert', async () => {
    const old = new Date(Date.now() - 3 * 24 * 3600e3).toISOString();
    const before = sounds().length;
    append('OLDSESS', WS, { ...prompt('ancient'), timestamp: old }, { ...done('ancient'), timestamp: old });
    await wait(1300);
    append('OLDSESS', WS, { type: 'summary', summary: 'Ancient' });
    await wait(1300);
    assert.strictEqual(sounds().length, before);
  });

  await t.test('foreign terminal hook: bell only, no sound', async () => {
    fs.writeFileSync(SETTINGS, JSON.stringify(hooks.addHooks({}, process.platform)));
    await wait(500);
    const before = sounds().length;
    fireHook('ct-other-window', { hook_event_name: 'Stop', session_id: 'F1' });
    await wait(4000);
    assert.strictEqual(sounds().length, before);
    assert.ok(statusItems['claudeTerminal.bell'].visible);
    await commands['claude-terminal.clearAlerts']();
  });

  await t.test('empty window only tracks its own terminals', async () => {
    vscode.workspace.workspaceFolders = undefined;
    const before = sounds().length;
    append('E1', WS2, prompt('x'), done('not mine'));
    await wait(1300);
    assert.strictEqual(sounds().length, before);
    const mine = terminals[0].creationOptions.env.CLAUDE_TERMINAL_ID;
    fireHook(mine, { hook_event_name: 'Stop', session_id: 'E2', cwd: '/anywhere' });
    await wait(4000);
    assert.strictEqual(sounds().length, before + 1);
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: WS } }];
    await commands['claude-terminal.clearAlerts']();
  });

  await t.test('a session launched in our terminal alerts even if it runs outside the workspace', async () => {
    await commands['claude-terminal.newSession']();
    const sid = sidOf(terminals.at(-1));
    await wait(1600);
    const before = sounds().length;
    append(sid, WS2, prompt('elsewhere'), done('ok'));
    await wait(1300);
    assert.strictEqual(sounds().length, before + 1);
    await commands['claude-terminal.clearAlerts']();
  });

  await t.test('dir name that does not encode the workspace (long-path hashing) is resolved via its cwd', async () => {
    await wait(1600);
    const odd = path.join(HOME, '.claude', 'projects', '-very-long-path-truncated-1a2b3c');
    fs.mkdirSync(odd, { recursive: true });
    await wait(300);
    const before = sounds().length;
    fs.writeFileSync(path.join(odd, 'LONG.jsonl'), [entry('LONG', WS, prompt('x')), entry('LONG', WS, done('y'))].join('\n') + '\n');
    await wait(1900);
    assert.strictEqual(sounds().length, before + 1);
    await commands['claude-terminal.clearAlerts']();
  });

  await t.test('no --session-id when user args already continue/resume', async () => {
    settings['terminal.args'] = '--continue';
    await commands['claude-terminal.newSession']();
    assert.strictEqual(terminals.at(-1).sent[0], 'claude --continue');
    settings['terminal.args'] = '';
  });

  await t.test('settings.json other keys survive install/uninstall', async () => {
    await commands['claude-terminal.uninstallHooks']();
    const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf-8'));
    assert.deepStrictEqual(s, {});
  });

  ext.deactivate();
});

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
