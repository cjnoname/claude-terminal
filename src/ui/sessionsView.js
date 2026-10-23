// Activity-bar tree listing recent Claude sessions and their live status.
const vscode = require('vscode');
const path = require('path');
const util = require('../util');

const STALE_MS = 15 * 60 * 1000;

const STATUS = {
  attention: { icon: 'bell-dot', color: 'charts.red', label: 'Needs input', order: 0 },
  running: { icon: 'loading~spin', color: 'charts.blue', label: 'Working', order: 1 },
  done: { icon: 'pass-filled', color: 'charts.green', label: 'Finished', order: 2 },
  idle: { icon: 'circle-outline', label: 'Idle', order: 3 },
};

class SessionsProvider {
  /**
   * @param {{sessions: Map<string, any>, isPending: (id: string) => boolean, isLive: (id: string) => boolean, recentHours: () => number}} deps
   */
  constructor(deps) {
    this.deps = deps;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this._timer = null;
  }

  /** Debounced refresh; many state changes arrive in bursts. */
  refresh() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._emitter.fire(), 150);
  }

  getChildren() {
    const { sessions, isPending, isLive, recentHours } = this.deps;
    const now = Date.now();
    const since = now - recentHours() * 3600 * 1000;
    const rank = (s) => (STATUS[s.status] || STATUS.idle).order;
    return [...sessions.values()]
      .filter((s) => s.updatedAt >= since || isPending(s.id) || isLive(s.id))
      .map((s) => {
        if (s.status === 'running' && now - s.updatedAt > STALE_MS) s.status = 'idle';
        return s;
      })
      .sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt);
  }

  getTreeItem(s) {
    const { isPending, isLive } = this.deps;
    const st = STATUS[s.status] || STATUS.idle;
    const live = isLive(s.id);
    const project = s.cwd ? path.basename(s.cwd) : '';
    const item = new vscode.TreeItem(s.title || project || s.id.slice(0, 8), vscode.TreeItemCollapsibleState.None);
    item.id = s.id;
    item.iconPath = new vscode.ThemeIcon(st.icon, st.color ? new vscode.ThemeColor(st.color) : undefined);
    item.description = [isPending(s.id) ? '●' : '', project, util.formatRelative(s.updatedAt)].filter(Boolean).join(' · ');
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${st.label}**${live ? ' · $(terminal) open' : ''}\n\n`);
    if (s.message) { md.appendText(s.message); md.appendMarkdown('\n\n'); }
    if (s.cwd) {
      md.appendMarkdown('$(folder) ');
      md.appendText(s.cwd);
      if (s.branch) { md.appendMarkdown('  $(git-branch) '); md.appendText(s.branch); }
      md.appendMarkdown('\n\n');
    }
    md.appendMarkdown('$(key) ');
    md.appendText(s.id);
    item.tooltip = md;
    item.contextValue = live ? 'session.live' : 'session';
    item.command = { command: 'claude-terminal.openSession', title: 'Open', arguments: [s.id] };
    return item;
  }

  dispose() {
    clearTimeout(this._timer);
    this._emitter.dispose?.();
  }
}

module.exports = { SessionsProvider };
