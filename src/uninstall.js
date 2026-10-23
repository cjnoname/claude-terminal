// Runs via the `vscode:uninstall` hook (plain Node, no vscode API) when the extension is
// fully uninstalled: removes our Claude Code hooks and leftover event/claim files.
const fs = require('fs');
const path = require('path');
const os = require('os');
const hooks = require('./hooks');
const jsonFile = require('./jsonFile');

function cleanup(home = os.homedir()) {
  const claudeDir = path.join(home, '.claude');
  const settings = path.join(claudeDir, 'settings.json');
  try {
    const cur = jsonFile.readJson(settings);
    if (hooks.hooksStatus(cur, process.platform) !== 'none') {
      jsonFile.updateJsonFileAtomic(settings, (d) => hooks.removeHooks(d));
    }
  } catch { /* missing or unparseable settings: leave untouched */ }
  for (const dir of [hooks.HOOK_MARKER, 'claude-terminal-state']) {
    try { fs.rmSync(path.join(claudeDir, dir), { recursive: true, force: true }); } catch {}
  }
}

if (require.main === module) cleanup();

module.exports = { cleanup };
