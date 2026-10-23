// Cross-window de-duplication: several VS Code windows may see the same Claude event.
// The first window to atomically create the claim file (O_EXCL) handles sound/notification/push.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TTL_MS = 10 * 60 * 1000;

function claimPath(dir, key) {
  return path.join(dir, crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 24));
}

/** @returns {boolean} true if this process won the claim (or claiming isn't possible — never silence alerts on I/O errors). */
function claim(dir, key, now = Date.now()) {
  const p = claimPath(dir, key);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.closeSync(fs.openSync(p, 'wx'));
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') return true;
    try {
      if (now - fs.statSync(p).mtimeMs > TTL_MS) { fs.unlinkSync(p); return claim(dir, key, now); }
    } catch {}
    return false;
  }
}

function gc(dir, now = Date.now()) {
  try {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      try { if (now - fs.statSync(p).mtimeMs > TTL_MS) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}

module.exports = { claim, gc, TTL_MS };
