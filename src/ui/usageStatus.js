// Status bar item with today's token usage (all sessions) and an API-price estimate.
const vscode = require('vscode');
const util = require('../util');
const { UsageTracker, dayStart } = require('../usage');

class UsageStatus {
  /**
   * @param {string} projectsDir
   * @param {(key: string) => any} cfg
   * @param {vscode.LogOutputChannel} log
   */
  constructor(projectsDir, cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.tracker = new UsageTracker(projectsDir);
    this.item = vscode.window.createStatusBarItem('claudeTerminal.usage', vscode.StatusBarAlignment.Right, 998);
    this.item.name = 'Claude Usage';
    this.item.command = 'claude-terminal.refreshUsage';
    this.dirty = true;
    this.day = 0;
    this.busy = false;
    this.rerun = false;
  }

  markDirty() {
    this.dirty = true;
  }

  async update(force = false) {
    if (!this.cfg('usage.showInStatusBar')) { this.item.hide(); return; }
    const today = dayStart();
    if (today !== this.day) force = true; // rolled over midnight
    if (!this.dirty && !force) return;
    if (this.busy) { this.rerun = true; return; }
    this.busy = true;
    this.dirty = false;
    try {
      const t = await this.tracker.compute(new Date(), this.cfg('usage.customPricing') || {});
      this.day = today;
      this.render(t);
    } catch (e) {
      this.dirty = true;
      this.log.warn(`Usage calc failed: ${e.message}`);
    } finally {
      this.busy = false;
      if (this.rerun) { this.rerun = false; this.dirty = true; this.update(true); }
    }
  }

  render(t) {
    const fmt = util.formatTokens;
    const tokens = t.input + t.output + t.cacheRead + t.cacheWrite;
    const showCost = this.cfg('usage.showCost') && t.cost > 0;
    this.item.text = `$(pulse) ${fmt(tokens)}${showCost ? ` · ~$${t.cost.toFixed(2)}` : ''}`;
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**Claude usage today** (all sessions)\n\n');
    md.appendMarkdown(`| | tokens |\n|---|---:|\n| Input | ${fmt(t.input)} |\n| Output | ${fmt(t.output)} |\n| Cache read | ${fmt(t.cacheRead)} |\n| Cache write | ${fmt(t.cacheWrite)} |\n\n`);
    for (const [m, v] of Object.entries(t.byModel).sort((a, b) => b[1].tokens - a[1].tokens)) {
      md.appendMarkdown('- ');
      md.appendText(m);
      md.appendMarkdown(`: ${fmt(v.tokens)}${v.priced ? ` · ~$${v.cost.toFixed(2)}` : ' · price unknown'}\n`);
    }
    const unpriced = t.unpricedTokens ? `; ${fmt(t.unpricedTokens)} tokens from unknown models not priced (see claudeTerminal.usage.customPricing)` : '';
    md.appendMarkdown(`\n_Estimate at public API list prices${unpriced}. Subscriptions and cloud providers bill differently._`);
    this.item.tooltip = md;
    this.item.show();
  }

  dispose() {
    this.item.dispose();
  }
}

module.exports = { UsageStatus };
