// Parsing of Claude Code transcript files (~/.claude/projects/<dir>/<session>.jsonl)
const fs = require('fs');
const { summarize } = require('./util');

const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

function parseLines(text, dropFirst, dropLast) {
  const lines = text.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* partial line */ }
  }
  return out;
}

function readChunk(file, fromEnd, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return { text: '', truncated: false };
    const n = Math.min(size, bytes);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, fromEnd ? size - n : 0);
    return { text: buf.toString('utf-8'), truncated: n < size };
  } catch {
    return { text: '', truncated: false };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function readTail(file, bytes = 256 * 1024) {
  const { text, truncated } = readChunk(file, true, bytes);
  return parseLines(text, truncated, false);
}

/**
 * Tail entries containing the recent conversation. Newer Claude Code versions append large
 * bookkeeping lines (attachments, request snapshots — tens of KB each), so a fixed window can miss
 * the last message: grow the window until it holds at least two conversation entries (so a
 * multi-line tool message is complete) or the whole file. Capped at 8 MB.
 */
function readRecent(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return []; }
  for (let bytes = 64 * 1024; ; bytes *= 2) {
    const entries = readTail(file, bytes);
    if (bytes >= size || bytes >= 8 * 1024 * 1024) return entries;
    let n = 0;
    for (let i = entries.length - 1; i >= 0 && n < 2; i--) if (isConversation(entries[i])) n++;
    if (n >= 2) return entries;
  }
}

function readHead(file, bytes = 64 * 1024) {
  const { text, truncated } = readChunk(file, false, bytes);
  return parseLines(text, false, truncated);
}

function isConversation(e) {
  return !!e && (e.type === 'assistant' || e.type === 'user') && !!e.message && !e.isSidechain;
}

function contentBlocks(e) {
  const c = e?.message?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [];
}

function extractText(e) {
  return contentBlocks(e).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
}

/** A prompt typed by the human (not a tool result, not injected meta content). */
function isRealPrompt(e) {
  if (!isConversation(e) || e.type !== 'user' || e.isMeta) return false;
  const blocks = contentBlocks(e);
  if (blocks.some((b) => b.type === 'tool_result')) return false;
  const text = extractText(e).trim();
  if (!text) return false;
  if (text.startsWith('<local-command') || text.startsWith('[Request interrupted')) return false;
  return true;
}

function promptTitle(e) {
  let t = extractText(e);
  const cmd = /<command-name>([^<]+)<\/command-name>/.exec(t);
  if (cmd) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(t);
    t = `${cmd[1]} ${args ? args[1] : ''}`;
  }
  return summarize(t, 70);
}

function describeTool(block) {
  const i = block.input || {};
  const detail = i.command || i.file_path || i.notebook_path || i.path || i.url || i.pattern || i.query || '';
  return summarize(`${block.name}${detail ? ': ' + detail : ''}`, 80);
}

function ts(e) {
  const t = Date.parse(e?.timestamp);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Summarise the current state of a session from the tail of its transcript.
 * status: 'done' | 'tool' | 'ask' | 'running' | 'interrupted' | 'unknown'
 */
function analyze(entries) {
  let last = null;
  let lastPrompt = null;
  let permissionMode = null;
  let sessionId = null;
  let cwd = null;
  let gitBranch = null;
  let title = null;
  let entrypoint = null;

  for (const e of entries) {
    if (e.sessionId) sessionId = e.sessionId;
    if (e.cwd) cwd = e.cwd;
    if (e.gitBranch) gitBranch = e.gitBranch;
    if (e.permissionMode) permissionMode = e.permissionMode;
    if (e.entrypoint) entrypoint = e.entrypoint;
    if (e.type === 'summary' && e.summary) title = e.summary;
    if (isConversation(e)) {
      last = e;
      if (isRealPrompt(e)) lastPrompt = e;
    }
  }

  const res = {
    sessionId, cwd, gitBranch, permissionMode, title, entrypoint,
    /** `claude -p` / Agent SDK runs: nobody is waiting at a prompt */
    nonInteractive: /^sdk/i.test(entrypoint || ''),
    last, lastPromptAt: ts(lastPrompt), lastPromptText: lastPrompt ? promptTitle(lastPrompt) : '',
    lastAt: ts(last), status: 'unknown', message: '', toolBlocks: [],
  };
  if (!last) return res;

  if (last.type === 'assistant') {
    const stop = last.message.stop_reason;
    if (stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens') {
      res.status = 'done';
      res.message = summarize(extractText(last));
    } else if (stop === 'tool_use') {
      res.toolBlocks = trailingToolBlocks(entries, last);
      const ask = res.toolBlocks.find((b) => ASK_TOOLS.has(b.name));
      if (ask) {
        res.status = 'ask';
        res.message = ask.name === 'ExitPlanMode' ? 'Plan ready for review' : askQuestionText(ask);
      } else {
        res.status = 'tool';
        res.message = res.toolBlocks[0] ? describeTool(res.toolBlocks[0]) : '';
      }
    } else {
      res.status = 'running';
    }
  } else {
    const text = extractText(last);
    res.status = text.startsWith('[Request interrupted') ? 'interrupted' : 'running';
  }
  return res;
}

/**
 * Claude Code writes one line per content block, so a message with several tool calls spans
 * several lines sharing a message id. Collect every tool_use of that trailing message.
 */
function trailingToolBlocks(entries, last) {
  const id = last.message?.id;
  const blocks = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!isConversation(e)) continue;
    if (e.type !== 'assistant') break;
    if (e !== last && (!id || e.message?.id !== id)) break;
    blocks.unshift(...contentBlocks(e).filter((b) => b.type === 'tool_use'));
    if (!id) break;
  }
  return blocks;
}

function askQuestionText(block) {
  const q = block.input?.questions?.[0]?.question || block.input?.question;
  return q ? summarize('Question: ' + q) : 'Claude has a question';
}

/** First real prompt of a session — used as its title. */
function sessionTitle(file) {
  const head = readHead(file);
  const s = head.find((e) => e.type === 'summary' && e.summary);
  if (s) return summarize(s.summary, 70);
  const p = head.find(isRealPrompt);
  return p ? promptTitle(p) : '';
}

module.exports = {
  ASK_TOOLS, readTail, readRecent, readHead, analyze, sessionTitle, extractText,
  isRealPrompt, describeTool, isConversation, parseLines,
};
