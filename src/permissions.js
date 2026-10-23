// Approximates Claude Code's permission rules so we can tell whether a pending
// tool call is waiting for the user's approval or simply still running.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { isPathInside } = require('./util');

const READ_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'TodoRead', 'Task', 'Agent',
  'TaskOutput', 'BashOutput', 'KillShell', 'KillBash', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
]);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const ALWAYS_ASK_TOOLS = new Set(['WebFetch', 'WebSearch']);
const MAYBE_AUTO_BASH = /^\s*(ls|pwd|echo|cat|head|tail|wc|which|whoami|date|tree|git\s+(status|diff|log|show|branch))\b/;

const fileCache = new Map(); // path -> {mtimeMs, perms}

function readPerms(file) {
  try {
    const st = fs.statSync(file);
    const hit = fileCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.perms;
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const perms = json.permissions || {};
    fileCache.set(file, { mtimeMs: st.mtimeMs, perms });
    return perms;
  } catch {
    return null;
  }
}

function loadRules(cwd, home = os.homedir()) {
  const files = [
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.claude', 'settings.local.json'),
  ];
  if (cwd) files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  const rules = { allow: [], deny: [], ask: [], defaultMode: null, additionalDirectories: [] };
  for (const f of files) {
    const p = readPerms(f);
    if (!p) continue;
    for (const k of ['allow', 'deny', 'ask', 'additionalDirectories']) {
      if (Array.isArray(p[k])) rules[k].push(...p[k]);
    }
    if (p.defaultMode) rules.defaultMode = p.defaultMode;
  }
  return rules;
}

function parseRule(r) {
  const m = /^([^()]+?)(?:\((.*)\))?$/.exec(String(r).trim());
  return m ? { tool: m[1].trim(), spec: m[2] } : null;
}

function escapeRe(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function bashSpecMatches(spec, command) {
  const s = spec.endsWith(':*') ? spec.slice(0, -2) + '*' : spec;
  const re = new RegExp('^' + s.split('*').map(escapeRe).join('.*') + '$', 's');
  return re.test(command.trim());
}

function pathGlobToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += escapeRe(c);
  }
  return new RegExp('^' + re + '$');
}

function resolveSpecPath(spec, cwd, home) {
  if (spec.startsWith('//')) return spec.slice(1);
  if (spec.startsWith('~/')) return path.join(home, spec.slice(2));
  if (spec.startsWith('/')) return path.join(cwd || '/', spec.slice(1));
  return path.join(cwd || '/', spec.replace(/^\.\//, ''));
}

function filePathOf(block) {
  const i = block.input || {};
  return i.file_path || i.notebook_path || i.path || null;
}

function ruleMatches(rule, block, cwd, home) {
  const r = parseRule(rule);
  if (!r) return false;
  const name = block.name;

  if (r.tool.startsWith('mcp__')) {
    if (r.tool.endsWith('__*')) return name.startsWith(r.tool.slice(0, -1));
    return name === r.tool || name.startsWith(r.tool + '__');
  }

  const sameTool = r.tool === name || (r.tool === 'Edit' && EDIT_TOOLS.has(name)) || (r.tool === 'Read' && READ_TOOLS.has(name));
  if (!sameTool) return false;
  if (r.spec === undefined || r.spec === '' || r.spec === '*') return true;

  if (name === 'Bash') return bashSpecMatches(r.spec, String(block.input?.command || ''));
  if (name === 'WebFetch') {
    const m = /^domain:(.+)$/.exec(r.spec);
    if (!m) return false;
    try {
      const host = new URL(block.input?.url).hostname;
      return host === m[1] || host.endsWith('.' + m[1]);
    } catch { return false; }
  }
  const p = filePathOf(block);
  if (!p) return false;
  const target = resolveSpecPath(r.spec, cwd, home);
  if (!/[*?]/.test(r.spec)) return isPathInside(p, target);
  return pathGlobToRe(target.split(path.sep).join('/')).test(path.resolve(p).split(path.sep).join('/'));
}

/**
 * @returns {'allow'|'deny'|'ask'|'unknown'}
 *  allow   – runs without asking (no alert)
 *  deny    – auto-rejected (no alert)
 *  ask     – Claude Code will prompt the user
 *  unknown – can't tell; fall back to a time-based guess
 */
function classify(block, { mode, rules, cwd, home = os.homedir() }) {
  const any = (list) => list.some((r) => ruleMatches(r, block, cwd, home));
  if (any(rules.deny)) return 'deny';
  if (any(rules.ask)) return 'ask';
  let effectiveMode = mode || rules.defaultMode || 'default';
  if (effectiveMode === 'manual') effectiveMode = 'default';
  if (effectiveMode === 'bypassPermissions') return 'allow';
  if (any(rules.allow)) return 'allow';
  // dontAsk never prompts: anything not pre-approved is denied
  if (effectiveMode === 'dontAsk') return 'deny';

  const name = block.name;
  const p = filePathOf(block);
  const roots = [cwd, ...rules.additionalDirectories.map((d) => resolveSpecPath(d, cwd, home))].filter(Boolean);
  const inside = !p || roots.some((r) => isPathInside(p, r));

  if (READ_TOOLS.has(name)) return inside ? 'allow' : 'unknown';
  // auto mode: a classifier approves most actions on its own — we can't predict when it will ask
  if (effectiveMode === 'auto') return 'unknown';
  if (EDIT_TOOLS.has(name)) {
    if (effectiveMode === 'acceptEdits' && inside) return 'allow';
    return effectiveMode === 'plan' ? 'unknown' : 'ask';
  }
  if (name === 'Bash') return MAYBE_AUTO_BASH.test(String(block.input?.command || '')) ? 'unknown' : 'ask';
  if (name.startsWith('mcp__') || ALWAYS_ASK_TOOLS.has(name)) return 'ask';
  return 'unknown';
}

/** Classify all pending tool calls; the "most blocking" verdict wins. */
function classifyAll(blocks, ctx) {
  const verdicts = blocks.map((b) => classify(b, ctx));
  if (verdicts.includes('ask')) return 'ask';
  if (verdicts.includes('unknown')) return 'unknown';
  if (verdicts.length && verdicts.every((v) => v === 'deny')) return 'deny';
  return 'allow';
}

module.exports = { loadRules, classify, classifyAll, parseRule, ruleMatches, bashSpecMatches };
