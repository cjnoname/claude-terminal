// Safe read-modify-write for JSON settings files (e.g. ~/.claude/settings.json).
const fs = require('fs');
const path = require('path');

function readRaw(file) {
  try { return fs.readFileSync(file, 'utf-8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function parse(raw, file) {
  if (raw === null || raw.trim() === '') return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('top level is not an object');
    return v;
  } catch (e) {
    throw new Error(`Cannot parse ${file}: ${e.message}`, { cause: e });
  }
}

function readJson(file) {
  return parse(readRaw(file), file);
}

function pruneBackups(file, keep) {
  const dir = path.dirname(file);
  const prefix = path.basename(file) + '.claude-terminal-';
  try {
    const olds = fs.readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith('.bak')).sort();
    for (const n of olds.slice(0, Math.max(0, olds.length - keep))) fs.unlinkSync(path.join(dir, n));
  } catch {}
}

/**
 * Applies `transform` to the current JSON content and writes the result atomically
 * (temp file + rename). If the file changes while we work, the transform is re-applied
 * to the fresh content. A timestamped backup of the previous content is kept.
 * @param {string} file
 * @param {(data: object) => object} transform
 * @param {{beforeWrite?: () => void, keepBackups?: number}} [opts] beforeWrite is a test seam
 * @returns {{backup: string|null}}
 */
function updateJsonFileAtomic(file, transform, opts = {}) {
  // Write through symlinks (dotfile managers) instead of replacing the link with a regular file.
  try { file = fs.realpathSync(file); } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = readRaw(file);
    const next = transform(parse(raw, file));
    const text = JSON.stringify(next, null, 2) + '\n';
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    let mode;
    try { mode = fs.statSync(file).mode & 0o777; } catch {}
    fs.writeFileSync(tmp, text, { mode: mode ?? 0o600 });
    try {
      opts.beforeWrite?.();
      if (readRaw(file) !== raw) { fs.unlinkSync(tmp); continue; } // changed under us – redo
      let backup = null;
      if (raw !== null) {
        backup = `${file}.claude-terminal-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
        fs.writeFileSync(backup, raw, { mode: mode ?? 0o600 });
        pruneBackups(file, opts.keepBackups ?? 3);
      }
      fs.renameSync(tmp, file);
      return { backup };
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  }
  throw new Error(`${file} kept changing; please try again.`);
}

module.exports = { readJson, updateJsonFileAtomic };
