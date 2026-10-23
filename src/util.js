const fs = require('fs');
const path = require('path');

const realCache = new Map();

/**
 * Resolve symlinks (e.g. macOS /var → /private/var; Claude records the real cwd). For paths that
 * don't exist yet (a file Claude is about to create) the nearest existing ancestor is resolved.
 */
function realPath(p) {
  const abs = path.resolve(p);
  let r = realCache.get(abs);
  if (r !== undefined) return r;
  try {
    r = fs.realpathSync.native(abs);
  } catch {
    const parent = path.dirname(abs);
    r = parent === abs ? abs : path.join(realPath(parent), path.basename(abs));
  }
  if (realCache.size > 2000) realCache.clear();
  realCache.set(abs, r);
  return r;
}

function summarize(s, max = 90) {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

function formatRelative(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** "22:00-08:00" -> {start, end} in minutes, or null */
function parseQuietHours(spec) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(spec || '');
  if (!m) return null;
  const start = +m[1] * 60 + +m[2];
  const end = +m[3] * 60 + +m[4];
  if (start > 1439 || end > 1439 || start === end) return null;
  return { start, end };
}

function inQuietHours(spec, date = new Date()) {
  const q = parseQuietHours(spec);
  if (!q) return false;
  const cur = date.getHours() * 60 + date.getMinutes();
  return q.start < q.end ? cur >= q.start && cur < q.end : cur >= q.start || cur < q.end;
}

/** Claude Code stores transcripts in ~/.claude/projects/<cwd with non-alphanumerics replaced by '-'> */
function encodeProjectDir(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Does a ~/.claude/projects directory name belong to `cwd` (or a folder below it)?
 * Case-insensitive where the file system is (VS Code lower-cases Windows drive letters, Claude doesn't).
 */
function projectDirMatches(dirName, cwd, platform = process.platform) {
  const fold = (s) => (platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s);
  const d = fold(dirName);
  const p = fold(encodeProjectDir(path.isAbsolute(cwd) ? realPath(cwd) : cwd));
  return d === p || d.startsWith(p + '-');
}

function normalizePath(p, platform = process.platform) {
  if (!p) return '';
  let r = realPath(p);
  if (platform === 'win32' || platform === 'darwin') r = r.toLowerCase();
  return r;
}

function isPathInside(child, root, platform = process.platform) {
  if (!child || !root) return false;
  const c = normalizePath(child, platform);
  const r = normalizePath(root, platform);
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

module.exports = {
  summarize, formatDuration, formatTokens, formatRelative,
  parseQuietHours, inQuietHours, encodeProjectDir, projectDirMatches, realPath, normalizePath, isPathInside,
};
