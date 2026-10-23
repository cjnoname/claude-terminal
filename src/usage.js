// Today's token usage across Claude Code transcripts, with an (optional) API-price estimate.
const fs = require('fs');
const path = require('path');

/**
 * USD per million tokens at public API list prices, or null for models we don't know.
 * @param {string} model
 * @param {Record<string, {input: number, output: number}>} [custom] substring -> price, checked first
 */
function pricing(model, custom) {
  const m = String(model || '').toLowerCase();
  let p = null;
  for (const [k, v] of Object.entries(custom || {})) {
    if (k && m.includes(k.toLowerCase()) && Number.isFinite(v?.input) && Number.isFinite(v?.output)) { p = { input: v.input, output: v.output }; break; }
  }
  if (!p) {
    if (/opus-4-[5-9]|opus-[5-9]/.test(m)) p = { input: 5, output: 25 };
    else if (/opus/.test(m)) p = { input: 15, output: 75 };
    else if (/sonnet/.test(m)) p = { input: 3, output: 15 };
    else if (/haiku-4|haiku-[5-9]/.test(m)) p = { input: 1, output: 5 };
    else if (/3-5-haiku|haiku-3-5/.test(m)) p = { input: 0.8, output: 4 };
    else if (/haiku/.test(m)) p = { input: 0.25, output: 1.25 };
  }
  if (!p) return null;
  return { ...p, cacheWrite5m: p.input * 1.25, cacheWrite1h: p.input * 2, cacheRead: p.input * 0.1 };
}

function emptyTotals() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpricedTokens: 0, byModel: {} };
}

function modelKey(model) {
  return String(model || 'unknown').replace(/^(?:[a-z]{2,4}\.)?anthropic\./, '').replace(/-v\d+:\d+$/, '');
}

function addUsage(t, model, u, custom) {
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const write1h = Math.min(cacheWrite, u.cache_creation?.ephemeral_1h_input_tokens || 0);
  const write5m = cacheWrite - write1h;
  const tokens = input + output + cacheRead + cacheWrite;
  t.input += input; t.output += output; t.cacheRead += cacheRead; t.cacheWrite += cacheWrite;

  const p = pricing(model, custom);
  let cost = null;
  if (p) {
    cost = (input * p.input + output * p.output + cacheRead * p.cacheRead + write5m * p.cacheWrite5m + write1h * p.cacheWrite1h) / 1e6;
    t.cost += cost;
  } else {
    t.unpricedTokens += tokens;
  }
  const key = modelKey(model);
  const b = (t.byModel[key] = t.byModel[key] || { tokens: 0, cost: 0, priced: !!p });
  b.tokens += tokens;
  if (cost !== null) b.cost += cost;
}

function dayStart(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Collect assistant usage records from JSONL text into `seen` (message id -> record); streamed duplicates overwrite. */
function collect(text, since, seen) {
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'assistant' || !e.message?.usage) continue;
    const t = Date.parse(e.timestamp);
    if (!(t >= since)) continue;
    seen.set(e.message.id || e.uuid || `${t}:${seen.size}`, { model: e.message.model, usage: e.message.usage });
  }
}

function totalsOf(seenMaps, custom) {
  const totals = emptyTotals();
  for (const seen of seenMaps) for (const { model, usage } of seen.values()) addUsage(totals, model, usage, custom);
  return totals;
}

function usageFromText(text, since, custom) {
  const seen = new Map();
  collect(text, since, seen);
  return totalsOf([seen], custom);
}

const MAX_READ_PER_PASS = 32 * 1024 * 1024;

class UsageTracker {
  constructor(projectsDir) {
    this.projectsDir = projectsDir;
    /** @type {Map<string, {day: number, offset: number, seen: Map<string, any>}>} */
    this.files = new Map();
    this.day = 0;
  }

  /** Reads only bytes appended since the previous pass. */
  async _ingest(file, size, since) {
    let st = this.files.get(file);
    if (!st || st.day !== since || size < st.offset) {
      st = { day: since, offset: 0, seen: new Map() };
      this.files.set(file, st);
    }
    if (size === st.offset) return;
    const fh = await fs.promises.open(file, 'r');
    try {
      while (st.offset < size) {
        const len = Math.min(size - st.offset, MAX_READ_PER_PASS);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, st.offset);
        const lastNl = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
        if (lastNl < 0) {
          // A single line longer than the read window: skip it rather than loop forever
          if (len === MAX_READ_PER_PASS) { st.offset += bytesRead; continue; }
          break; // incomplete trailing line; wait for the rest
        }
        collect(buf.subarray(0, lastNl).toString('utf-8'), since, st.seen);
        st.offset += lastNl + 1;
      }
    } finally {
      await fh.close();
    }
  }

  async compute(now = new Date(), custom) {
    const since = dayStart(now);
    if (since !== this.day) { this.files.clear(); this.day = since; }
    let dirs;
    try { dirs = await fs.promises.readdir(this.projectsDir, { withFileTypes: true }); } catch { return emptyTotals(); }
    const live = new Set();
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(this.projectsDir, d.name);
      let names;
      try { names = await fs.promises.readdir(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(dir, name);
        let st;
        try { st = await fs.promises.stat(file); } catch { continue; }
        if (st.mtimeMs < since) continue;
        live.add(file);
        try { await this._ingest(file, st.size, since); } catch {}
      }
    }
    for (const k of this.files.keys()) if (!live.has(k)) this.files.delete(k);
    return totalsOf([...this.files.values()].map((f) => f.seen), custom);
  }
}

module.exports = { UsageTracker, usageFromText, pricing, dayStart };
