const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const util = require('../src/util');
const transcript = require('../src/transcript');
const permissions = require('../src/permissions');
const sound = require('../src/sound');
const push = require('../src/push');
const hooks = require('../src/hooks');
const usage = require('../src/usage');
const jsonFile = require('../src/jsonFile');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-test-'));
const write = (name, entries) => {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return f;
};
const user = (text, t = '2026-01-01T10:00:00Z') => ({ type: 'user', uuid: 'u' + Math.random(), timestamp: t, sessionId: 'S', cwd: '/w/proj', message: { role: 'user', content: text } });
const asst = (stop, content, t = '2026-01-01T10:01:00Z') => ({ type: 'assistant', uuid: 'a' + Math.random(), timestamp: t, sessionId: 'S', cwd: '/w/proj', message: { stop_reason: stop, content } });

// ── util ──
test('formatDuration', () => {
  assert.strictEqual(util.formatDuration(5000), '5s');
  assert.strictEqual(util.formatDuration(192000), '3m 12s');
  assert.strictEqual(util.formatDuration(3 * 3600e3 + 60e3), '3h 1m');
});

test('quiet hours across midnight', () => {
  const at = (h, m) => new Date(2026, 0, 1, h, m);
  assert.ok(util.inQuietHours('22:00-08:00', at(23, 0)));
  assert.ok(util.inQuietHours('22:00-08:00', at(7, 59)));
  assert.ok(!util.inQuietHours('22:00-08:00', at(8, 0)));
  assert.ok(util.inQuietHours('12:00-13:00', at(12, 30)));
  assert.ok(!util.inQuietHours('', at(12, 30)));
  assert.ok(!util.inQuietHours('garbage', at(12, 30)));
});

test('encodeProjectDir matches Claude Code', () => {
  assert.strictEqual(util.encodeProjectDir('/Users/me/my.app'), '-Users-me-my-app');
});

test('projectDirMatches: Windows drive-letter case and sub-folders', () => {
  assert.ok(util.projectDirMatches('C--Users-me-proj', 'c:\\Users\\me\\proj', 'win32'));
  assert.ok(util.projectDirMatches('C--Users-me-proj-sub', 'c:\\Users\\me\\proj', 'win32'));
  assert.ok(!util.projectDirMatches('-home-Me-proj', '/home/me/proj', 'linux'), 'case-sensitive on Linux');
  assert.ok(!util.projectDirMatches('-a-projX', '/a/proj', 'linux'));
});

test('paths are compared through symlinks', () => {
  const real = path.join(tmp, 'realproj');
  const link = path.join(tmp, 'linkproj');
  fs.mkdirSync(path.join(real, 'sub'), { recursive: true });
  fs.symlinkSync(real, link);
  assert.ok(util.isPathInside(path.join(real, 'sub'), link), 'workspace opened via a symlink');
  assert.ok(util.projectDirMatches(util.encodeProjectDir(fs.realpathSync(real)), link));
  assert.ok(util.isPathInside(path.join(link, 'new-dir', 'not-yet.txt'), real), 'files that do not exist yet');
});

test('isPathInside', () => {
  assert.ok(util.isPathInside('/a/b/c', '/a/b', 'linux'));
  assert.ok(!util.isPathInside('/a/bc', '/a/b', 'linux'));
});

// ── transcript ──
test('done detection skips trailing metadata lines', () => {
  const f = write('done.jsonl', [user('fix the bug'), asst('end_turn', [{ type: 'text', text: 'Fixed it.' }]), { type: 'last-prompt' }, { type: 'permission-mode', permissionMode: 'default' }]);
  const a = transcript.analyze(transcript.readTail(f));
  assert.strictEqual(a.status, 'done');
  assert.strictEqual(a.message, 'Fixed it.');
  assert.strictEqual(a.lastAt - a.lastPromptAt, 60000);
  assert.strictEqual(a.permissionMode, 'default');
});

test('tool_result is not a real prompt', () => {
  const f = write('tool.jsonl', [
    user('run tests'),
    asst('tool_use', [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]),
    { ...user(''), message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
  ]);
  const a = transcript.analyze(transcript.readTail(f));
  assert.strictEqual(a.status, 'running');
  assert.strictEqual(a.lastPromptText, 'run tests');
});

test('AskUserQuestion / ExitPlanMode are attention', () => {
  const q = transcript.analyze([asst('tool_use', [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Which DB?' }] } }])]);
  assert.strictEqual(q.status, 'ask');
  assert.match(q.message, /Which DB/);
  const p = transcript.analyze([asst('tool_use', [{ type: 'tool_use', name: 'ExitPlanMode', input: {} }])]);
  assert.strictEqual(p.status, 'ask');
});

test('interrupt and sidechain', () => {
  assert.strictEqual(transcript.analyze([asst('tool_use', []), user('[Request interrupted by user]')]).status, 'interrupted');
  const side = { ...asst('end_turn', [{ type: 'text', text: 'sub' }]), isSidechain: true };
  assert.strictEqual(transcript.analyze([user('hi'), side]).status, 'running');
});

test('readTail drops partial first line', () => {
  const big = [];
  for (let i = 0; i < 200; i++) big.push(user('x'.repeat(100)));
  big.push(asst('end_turn', [{ type: 'text', text: 'end' }]));
  const f = write('big.jsonl', big);
  const a = transcript.analyze(transcript.readTail(f, 4096));
  assert.strictEqual(a.status, 'done');
});

test('readRecent finds the last message behind large bookkeeping lines (Claude Code 2.1+)', () => {
  const blob = (n) => ({ type: 'attachment', attachment: 'x'.repeat(n) });
  const f = write('heavy.jsonl', [user('go'), asst('end_turn', [{ type: 'text', text: 'Done.' }]), blob(60000), { type: 'api-request-shape', s: 'y'.repeat(150000) }, blob(120000), { type: 'cost-state' }]);
  assert.strictEqual(transcript.analyze(transcript.readTail(f)).status, 'unknown', 'a fixed 256 KB window misses it');
  const a = transcript.analyze(transcript.readRecent(f));
  assert.strictEqual(a.status, 'done');
  assert.strictEqual(a.message, 'Done.');
});

test('session title from first prompt / slash command', () => {
  const f = write('title.jsonl', [{ type: 'permission-mode' }, user('<command-name>/review</command-name><command-args>PR 12</command-args>'), user('second')]);
  assert.strictEqual(transcript.sessionTitle(f), '/review PR 12');
});

// ── permissions ──
const rules = (o = {}) => ({ allow: [], deny: [], ask: [], defaultMode: null, additionalDirectories: [], ...o });
const tool = (name, input) => ({ type: 'tool_use', name, input });
const ctx = (r, mode = 'default') => ({ mode, rules: r, cwd: '/w/proj', home: '/home/me' });

test('bash allow rules (legacy :* and glob)', () => {
  const r = rules({ allow: ['Bash(npm run check*)', 'Bash(git log:*)'] });
  assert.strictEqual(permissions.classify(tool('Bash', { command: 'npm run check' }), ctx(r)), 'allow');
  assert.strictEqual(permissions.classify(tool('Bash', { command: 'git log --oneline' }), ctx(r)), 'allow');
  assert.strictEqual(permissions.classify(tool('Bash', { command: 'rm -rf build' }), ctx(r)), 'ask');
  assert.strictEqual(permissions.classify(tool('Bash', { command: 'ls -la' }), ctx(r)), 'unknown');
});

test('deny beats allow; bypass mode allows', () => {
  const r = rules({ allow: ['Bash'], deny: ['Bash(curl:*)'] });
  assert.strictEqual(permissions.classify(tool('Bash', { command: 'curl x' }), ctx(r)), 'deny');
  assert.strictEqual(permissions.classify(tool('Bash', { command: 'make' }), ctx(rules(), 'bypassPermissions')), 'allow');
});

test('edits depend on mode and location', () => {
  const inside = tool('Edit', { file_path: '/w/proj/a.js' });
  const outside = tool('Write', { file_path: '/etc/hosts' });
  assert.strictEqual(permissions.classify(inside, ctx(rules())), 'ask');
  assert.strictEqual(permissions.classify(inside, ctx(rules(), 'acceptEdits')), 'allow');
  assert.strictEqual(permissions.classify(outside, ctx(rules(), 'acceptEdits')), 'ask');
  assert.strictEqual(permissions.classify(tool('Edit', { file_path: '/w/proj/src/x.ts' }), ctx(rules({ allow: ['Edit(src/**)'] }))), 'allow');
});

test('reads inside cwd are allowed; mcp and webfetch ask', () => {
  assert.strictEqual(permissions.classify(tool('Read', { file_path: '/w/proj/a' }), ctx(rules())), 'allow');
  assert.strictEqual(permissions.classify(tool('Grep', { pattern: 'x' }), ctx(rules())), 'allow');
  assert.strictEqual(permissions.classify(tool('Read', { file_path: '/other/a' }), ctx(rules())), 'unknown');
  assert.strictEqual(permissions.classify(tool('mcp__github__create_issue', {}), ctx(rules())), 'ask');
  assert.strictEqual(permissions.classify(tool('mcp__github__create_issue', {}), ctx(rules({ allow: ['mcp__github'] }))), 'allow');
  assert.strictEqual(permissions.classify(tool('WebFetch', { url: 'https://docs.x.com/a' }), ctx(rules({ allow: ['WebFetch(domain:x.com)'] }))), 'allow');
});

test('newer permission modes: auto, dontAsk, manual', () => {
  const bash = tool('Bash', { command: 'rm -rf build' });
  assert.strictEqual(permissions.classify(bash, ctx(rules(), 'auto')), 'unknown', 'auto: classifier decides');
  assert.strictEqual(permissions.classify(tool('Edit', { file_path: '/w/proj/a' }), ctx(rules(), 'auto')), 'unknown');
  assert.strictEqual(permissions.classify(bash, ctx(rules({ allow: ['Bash(rm:*)'] }), 'auto')), 'allow');
  assert.strictEqual(permissions.classify(bash, ctx(rules(), 'dontAsk')), 'deny', 'dontAsk never prompts');
  assert.strictEqual(permissions.classify(bash, ctx(rules(), 'manual')), 'ask', 'manual = default');
});

test('classifyAll picks the most blocking verdict', () => {
  const r = rules();
  assert.strictEqual(permissions.classifyAll([tool('Read', { file_path: '/w/proj/a' }), tool('Bash', { command: 'rm x' })], ctx(r)), 'ask');
  assert.strictEqual(permissions.classifyAll([tool('Read', { file_path: '/w/proj/a' })], ctx(r)), 'allow');
});

test('loadRules merges user + project settings', () => {
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'proj');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(a)'] } }));
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(b)'], defaultMode: 'acceptEdits' } }));
  const r = permissions.loadRules(cwd, home);
  assert.deepStrictEqual(r.allow, ['Bash(a)', 'Bash(b)']);
  assert.strictEqual(r.defaultMode, 'acceptEdits');
});

// ── sound ──
test('sound commands per platform', () => {
  assert.match(sound.buildPlayCommand({ platform: 'darwin', kind: 'done', name: 'Hero', volume: 0.5 }), /afplay -v 0\.50 '\/System\/Library\/Sounds\/Hero\.aiff'/);
  assert.match(sound.buildPlayCommand({ platform: 'darwin', kind: 'done', name: 'Nope', volume: 1 }), /Glass/);
  assert.match(sound.buildPlayCommand({ platform: 'linux', kind: 'attention', volume: 1 }), /dialog-warning/);
  const win = sound.buildPlayCommand({ platform: 'win32', kind: 'done', file: "C:\\it's.mp3", volume: 0.3 });
  const decoded = Buffer.from(win.split(' ').pop(), 'base64').toString('utf16le');
  assert.match(decoded, /'C:\\it''s\.mp3'/);
  assert.match(decoded, /Volume = 0\.30/);
});

test('notification command escapes quotes', () => {
  const c = sound.buildSystemNotificationCommand('darwin', 'It "works"', "it's");
  assert.ok(c.startsWith('osascript -e '));
  assert.ok(c.includes('\\"works\\"'));
});

// ── push ──
test('push request builders', () => {
  const n = { title: 'T', message: 'M', kind: 'attention', project: 'p', sessionId: 's' };
  const ntfy = push.buildPushRequest({ provider: 'ntfy', ntfyTopic: 'abc', ntfyServer: 'https://ntfy.sh/' }, n);
  assert.strictEqual(ntfy.url, 'https://ntfy.sh');
  assert.strictEqual(JSON.parse(ntfy.init.body).topic, 'abc');
  assert.strictEqual(push.buildPushRequest({ provider: 'ntfy' }, n), null);
  const tg = push.buildPushRequest({ provider: 'telegram', telegramBotToken: 'K', telegramChatId: '1' }, n);
  assert.strictEqual(tg.url, 'https://api.telegram.org/botK/sendMessage');
  assert.strictEqual(push.buildPushRequest({ provider: 'none' }, n), null);
});

test('sendPush surfaces HTTP errors', async () => {
  const fake = async () => ({ ok: false, status: 403, text: async () => 'nope' });
  await assert.rejects(push.sendPush({ provider: 'webhook', webhookUrl: 'http://x' }, { title: 't' }, fake), /HTTP 403/);
});

test('push content levels never leak details by default', () => {
  const n = { kind: 'attention', project: 'secret-proj', message: 'Permission needed — Bash: deploy --token=abc' };
  const g = push.shapeContent(undefined, n);
  assert.ok(!JSON.stringify(g).includes('secret-proj') && !JSON.stringify(g).includes('abc'));
  assert.ok(push.shapeContent('project', n).title.includes('secret-proj'));
  assert.ok(!push.shapeContent('project', n).message.includes('abc'));
  assert.ok(push.shapeContent('full', n).message.includes('abc'));
});

// ── hooks ──
const EV_DIR = '/home/me/.claude/claude-terminal-events';

test('hooks add / status / remove keep user hooks', () => {
  const base = { env: { A: 1 }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } };
  assert.strictEqual(hooks.hooksStatus(base, 'darwin', EV_DIR), 'none');
  const added = hooks.addHooks(base, 'darwin', EV_DIR);
  assert.strictEqual(hooks.hooksStatus(added, 'darwin', EV_DIR), 'current');
  assert.strictEqual(added.hooks.Stop.length, 2);
  const twice = hooks.addHooks(added, 'darwin', EV_DIR);
  assert.strictEqual(hooks.hooksStatus(twice, 'darwin', EV_DIR), 'current');
  assert.strictEqual(twice.hooks.Stop.length, 2, 'idempotent');
  assert.deepStrictEqual(hooks.removeHooks(added), base);
});

test('hooks from older versions are detected as outdated and replaced', () => {
  const old = { hooks: { Stop: [{ hooks: [{ type: 'command', command: `cat >> /home/me/.claude/claude-terminal-events.jsonl` }] }] } };
  assert.strictEqual(hooks.hooksStatus(old, 'darwin', EV_DIR), 'outdated');
  const upgraded = hooks.addHooks(old, 'darwin', EV_DIR);
  assert.strictEqual(hooks.hooksStatus(upgraded, 'darwin', EV_DIR), 'current');
  assert.strictEqual(upgraded.hooks.Stop.length, 1);
  const partial = hooks.addHooks({}, 'darwin', EV_DIR);
  delete partial.hooks.Notification;
  assert.strictEqual(hooks.hooksStatus(partial, 'darwin', EV_DIR), 'outdated');
});

test('windows hook commands are recognised through base64', () => {
  const dir = 'C:\\u\\.claude\\claude-terminal-events';
  const win = hooks.addHooks({}, 'win32', dir);
  assert.strictEqual(hooks.hooksStatus(win, 'win32', dir), 'current');
  assert.deepStrictEqual(hooks.removeHooks(win), {});
});

test('malformed hooks sections do not crash', () => {
  assert.strictEqual(hooks.hooksStatus({ hooks: { Stop: 'nope', X: [null] } }, 'darwin', EV_DIR), 'none');
  assert.doesNotThrow(() => hooks.removeHooks({ hooks: { Stop: 'nope' } }));
});

test('posix hook writes one complete file per event, even under concurrency', async () => {
  const { exec } = require('child_process');
  const home = path.join(tmp, 'hookhome');
  const dir = path.join(home, '.claude', 'claude-terminal-events');
  fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, 'stale.json');
  fs.writeFileSync(stale, '{}');
  fs.utimesSync(stale, new Date(Date.now() - 3 * 3600e3), new Date(Date.now() - 3 * 3600e3));
  const cmd = hooks.hookCommand('linux');
  assert.ok(!cmd.includes(os.homedir()), 'home-relative, portable across machines');
  const run = (input, tid) => new Promise((resolve, reject) => {
    const p = exec(cmd, { env: { ...process.env, HOME: home, CLAUDE_TERMINAL_ID: tid }, shell: '/bin/sh' }, (e) => (e ? reject(e) : resolve()));
    p.stdin.end(input);
  });
  const big = 'x'.repeat(200 * 1024); // larger than a pipe buffer
  await Promise.all(Array.from({ length: 24 }, (_, i) =>
    run(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: `S${i}`, prompt: i % 4 === 0 ? big : `p\n"${i}"` }), `ct-${i}`)));
  const files = fs.readdirSync(dir);
  assert.ok(!files.includes('stale.json'), 'hook garbage-collects files older than an hour');
  assert.strictEqual(files.filter((f) => f.endsWith('.json')).length, 24);
  assert.ok(!files.some((f) => f.endsWith('.tmp')));
  const events = files.map((f) => hooks.parseHookLine(fs.readFileSync(path.join(dir, f), 'utf-8')));
  assert.ok(events.every(Boolean), 'every file parses');
  assert.deepStrictEqual(new Set(events.map((e) => e.tid)).size, 24);
  const e3 = events.find((e) => e.event.session_id === 'S3');
  assert.strictEqual(e3.tid, 'ct-3');
  assert.strictEqual(e3.event.prompt, 'p\n"3"', 'escaped newlines inside JSON strings survive');
  assert.strictEqual(hooks.parseHookLine('not json'), null);
});

// ── settings file ──
test('atomic JSON update keeps other keys, backs up, and survives concurrent edits', () => {
  const f = path.join(tmp, 'cfg', 'settings.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ env: { A: 1 } }));
  let raced = false;
  const { backup } = jsonFile.updateJsonFileAtomic(f, (d) => ({ ...d, hooks: { x: 1 } }), {
    beforeWrite: () => { if (!raced) { raced = true; fs.writeFileSync(f, JSON.stringify({ env: { A: 1 }, model: 'opus' })); } },
  });
  const now = JSON.parse(fs.readFileSync(f, 'utf-8'));
  assert.deepStrictEqual(now, { env: { A: 1 }, model: 'opus', hooks: { x: 1 } }, 'concurrent edit preserved');
  assert.ok(backup && fs.existsSync(backup));
  assert.ok(!fs.readdirSync(path.dirname(f)).some((n) => n.includes('.tmp-')));
});

test('atomic JSON update refuses to overwrite an unparseable file', () => {
  const f = path.join(tmp, 'cfg2', 'settings.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{ broken');
  assert.throws(() => jsonFile.updateJsonFileAtomic(f, (d) => d), /Cannot parse/);
  assert.strictEqual(fs.readFileSync(f, 'utf-8'), '{ broken');
});

test('backups are pruned', () => {
  const f = path.join(tmp, 'cfg3', 'settings.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{}');
  for (let i = 0; i < 6; i++) jsonFile.updateJsonFileAtomic(f, (d) => ({ ...d, n: i }), { keepBackups: 2 });
  assert.ok(fs.readdirSync(path.dirname(f)).filter((n) => n.endsWith('.bak')).length <= 2);
});

// ── usage ──
const usageLine = (id, t, model = 'claude-sonnet-4-5', u = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }) =>
  JSON.stringify({ type: 'assistant', timestamp: t, message: { id, model, usage: u } });

test('usage dedupes streamed messages and filters by day', () => {
  const since = Date.parse('2026-01-01T00:00:00Z');
  const text = [usageLine('m1', '2026-01-01T01:00:00Z'), usageLine('m1', '2026-01-01T01:00:01Z'), usageLine('m2', '2025-12-31T23:00:00Z'), usageLine('m3', '2026-01-01T02:00:00Z', 'au.anthropic.claude-opus-4-5-v1:0')].join('\n');
  const t = usage.usageFromText(text, since);
  assert.strictEqual(t.output, 200);
  assert.strictEqual(t.cacheRead, 2000);
  assert.ok(t.byModel['claude-opus-4-5']);
  const expected = (10 * 3 + 100 * 15 + 1000 * 0.3) / 1e6 + (10 * 5 + 100 * 25 + 1000 * 0.5) / 1e6;
  assert.ok(Math.abs(t.cost - expected) < 1e-9);
});

test('unknown models are not priced; custom pricing applies; 1h cache costs 2x', () => {
  const since = 0;
  const unknown = usage.usageFromText(usageLine('a', '2026-01-01T01:00:00Z', 'gpt-9'), since);
  assert.strictEqual(unknown.cost, 0);
  assert.strictEqual(unknown.unpricedTokens, 1110);
  const custom = usage.usageFromText(usageLine('a', '2026-01-01T01:00:00Z', 'gpt-9'), since, { 'gpt-9': { input: 1, output: 2 } });
  assert.ok(custom.cost > 0 && custom.unpricedTokens === 0);
  const u = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 1e6 } };
  assert.strictEqual(usage.usageFromText(usageLine('a', '2026-01-01T01:00:00Z', 'claude-sonnet-4', u), since).cost, 6);
});

test('pricing families', () => {
  assert.strictEqual(usage.pricing('claude-3-haiku-20240307').input, 0.25);
  assert.strictEqual(usage.pricing('claude-3-5-haiku-20241022').input, 0.8);
  assert.strictEqual(usage.pricing('claude-opus-4-1').output, 75);
  assert.strictEqual(usage.pricing('au.anthropic.claude-opus-4-8').output, 25);
  assert.strictEqual(usage.pricing('claude-haiku-4-5').input, 1);
  assert.strictEqual(usage.pricing('mystery'), null);
});

test('usage tracker reads incrementally and resets at midnight', async () => {
  const root = path.join(tmp, 'projects');
  const dir = path.join(root, '-p');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 's.jsonl');
  const day = new Date(2030, 0, 2, 12);
  const ts = (h) => new Date(2030, 0, 2, h).toISOString();
  fs.writeFileSync(f, usageLine('m1', ts(1)) + '\n');
  const touch = () => fs.utimesSync(f, day, day);
  touch();
  const tr = new usage.UsageTracker(root);
  assert.strictEqual((await tr.compute(day)).output, 100);
  fs.appendFileSync(f, usageLine('m2', ts(2)) + '\n' + usageLine('m3', ts(3)).slice(0, 20)); // partial trailing line
  touch();
  assert.strictEqual((await tr.compute(day)).output, 200);
  fs.appendFileSync(f, usageLine('m3', ts(3)).slice(20) + '\n');
  touch();
  assert.strictEqual((await tr.compute(day)).output, 300);
  assert.strictEqual(tr.files.get(f).offset, fs.statSync(f).size, 'only new bytes are read');
  fs.utimesSync(f, new Date(2030, 0, 3, 1), new Date(2030, 0, 3, 1));
  assert.strictEqual((await tr.compute(new Date(2030, 0, 3, 9))).output, 0, 'new day starts at zero');
});

test('multi-tool messages: every tool_use of the trailing message is classified', () => {
  const mk = (block, id = 'msg1') => ({ type: 'assistant', uuid: 'a' + Math.random(), message: { id, stop_reason: 'tool_use', content: [block] } });
  const a = transcript.analyze([user('go'), mk(tool('Bash', { command: 'rm -rf x' })), mk(tool('Read', { file_path: '/w/proj/a' }))]);
  assert.strictEqual(a.toolBlocks.length, 2);
  assert.strictEqual(permissions.classifyAll(a.toolBlocks, ctx(rules())), 'ask');
  const b = transcript.analyze([mk(tool('Bash', { command: 'rm' }), 'old'), user('ok'), mk(tool('Read', { file_path: '/w/proj/a' }), 'new')]);
  assert.strictEqual(b.toolBlocks.length, 1, 'does not reach into earlier messages');
});

test('notify-send cannot be fed options through the message', () => {
  const c = sound.buildSystemNotificationCommand('linux', '-t', '--icon=/etc/passwd');
  assert.match(c, /notify-send -a 'Claude Terminal' -- '-t' '--icon=\/etc\/passwd'/);
});

test('cross-window claims: exactly one winner', () => {
  const claims = require('../src/claims');
  const dir = path.join(tmp, 'claims');
  assert.strictEqual(claims.claim(dir, 'k1'), true);
  assert.strictEqual(claims.claim(dir, 'k1'), false);
  assert.strictEqual(claims.claim(dir, 'k2'), true);
  assert.strictEqual(claims.claim(dir, 'k1', Date.now() + claims.TTL_MS + 1000), true, 'stale claims expire');
  assert.strictEqual(claims.claim('/dev/null/nope', 'k'), true, 'I/O errors never silence alerts');
});

test('atomic update writes through symlinks', () => {
  const real = path.join(tmp, 'dot', 'settings.json');
  const link = path.join(tmp, 'dotlink', 'settings.json');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.writeFileSync(real, '{"a":1}');
  fs.symlinkSync(real, link);
  jsonFile.updateJsonFileAtomic(link, (d) => ({ ...d, b: 2 }));
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'link preserved');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(real, 'utf-8')), { a: 1, b: 2 });
});

test('uninstall cleanup removes only our hooks and files', () => {
  const { cleanup } = require('../src/uninstall');
  const home = path.join(tmp, 'uninst');
  const cdir = path.join(home, '.claude');
  fs.mkdirSync(path.join(cdir, 'claude-terminal-events'), { recursive: true });
  const user = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say hi' }] }] } };
  fs.writeFileSync(path.join(cdir, 'settings.json'), JSON.stringify(hooks.addHooks(user, process.platform)));
  cleanup(home);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(cdir, 'settings.json'), 'utf-8')), user);
  assert.ok(!fs.existsSync(path.join(cdir, 'claude-terminal-events')));
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
