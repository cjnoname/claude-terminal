// Phone notifications: credentials in SecretStorage, delayed sending with re-checks, setup wizard.
const vscode = require('vscode');
const crypto = require('crypto');
const push = require('../push');

const SECRET_KEYS = ['ntfyTopic', 'ntfyToken', 'barkUrl', 'telegramBotToken', 'telegramChatId', 'webhookUrl'];

class PushService {
  /**
   * @param {vscode.ExtensionContext} ctx
   * @param {(key: string) => any} cfg
   * @param {vscode.LogOutputChannel} log
   * @param {{muted: (kind: string) => boolean, userAtVsCode: () => boolean}} env
   *   muted: DND / quiet hours say no; userAtVsCode: some VS Code window is focused
   */
  constructor(ctx, cfg, log, env) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.log = log;
    this.env = env;
    this.secrets = {};
    this.timers = new Map();
  }

  async load() {
    const next = {};
    for (const k of SECRET_KEYS) next[k] = (await this.ctx.secrets.get(`push.${k}`)) || '';
    this.secrets = next;
  }

  config() {
    return { provider: this.cfg('push.provider'), ntfyServer: this.cfg('push.ntfyServer'), ...this.secrets };
  }

  enabled() {
    const p = this.cfg('push.provider');
    return !!p && p !== 'none';
  }

  allowedNow(kind) {
    return this.enabled() && !!this.cfg(kind === 'done' ? 'push.onDone' : 'push.onAttention') && !this.env.muted(kind);
  }

  /**
   * Send after `push.delaySeconds`, but only if `stillWanted()` is true then — the user may have
   * responded, muted or changed settings in the meantime.
   */
  schedule(key, kind, content, stillWanted) {
    this.cancel(key);
    if (!this.allowedNow(kind)) return;
    const delay = Math.max(0, Number(this.cfg('push.delaySeconds')) || 0) * 1000;
    this.timers.set(key, setTimeout(async () => {
      this.timers.delete(key);
      if (!stillWanted() || !this.allowedNow(kind)) return;
      if (this.cfg('push.onlyWhenAway') && this.env.userAtVsCode()) return;
      try {
        const shaped = push.shapeContent(this.cfg('push.content'), { kind, ...content });
        await push.sendPush(this.config(), { ...shaped, kind });
        this.log.info(`Push sent via ${this.cfg('push.provider')}`);
      } catch (e) {
        this.log.error(`Push failed: ${e.message}`);
      }
    }, delay));
  }

  cancel(key) {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
  }

  cancelAll() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  async sendTest(kind, title) {
    if (!this.enabled()) return;
    try {
      await push.sendPush(this.config(), { title, message: 'This is a test alert', kind });
      vscode.window.showInformationMessage(`Test push sent via ${this.cfg('push.provider')}.`);
    } catch (e) {
      vscode.window.showErrorMessage(`Push failed: ${e.message}`);
    }
  }

  async storeSecret(k, v) {
    if (v) await this.ctx.secrets.store(`push.${k}`, v); else await this.ctx.secrets.delete(`push.${k}`);
  }

  async setup() {
    const conf = vscode.workspace.getConfiguration('claudeTerminal.push');
    const p = await vscode.window.showQuickPick([
      { label: 'ntfy', value: 'ntfy', detail: 'Free, no account. Install the ntfy app and subscribe to a private topic name.' },
      { label: 'Bark', value: 'bark', detail: 'iOS. Paste the URL shown in the Bark app (https://api.day.app/<key>).' },
      { label: 'Telegram', value: 'telegram', detail: 'Bot token from @BotFather plus your chat id.' },
      { label: 'Webhook', value: 'webhook', detail: 'POST JSON to any URL (Slack/Discord/Feishu bridges, Home Assistant, …).' },
      { label: 'Turn off and forget credentials', value: 'none' },
    ], { placeHolder: 'Send alerts to your phone when you are away. Credentials are kept in VS Code secure storage.' });
    if (!p) return;
    const G = vscode.ConfigurationTarget.Global;
    const ask = (prompt, value, password = true) => vscode.window.showInputBox({ prompt, value, password, ignoreFocusOut: true });
    const s = this.secrets;

    if (p.value === 'none') {
      for (const k of SECRET_KEYS) await this.storeSecret(k, '');
      await conf.update('provider', 'none', G);
      await this.load();
      vscode.window.showInformationMessage('Phone notifications turned off and credentials removed.');
      return;
    }
    if (p.value === 'ntfy') {
      const topic = await ask('ntfy topic — treat it like a password: anyone who knows it can read your alerts',
        s.ntfyTopic || `claude-${crypto.randomBytes(9).toString('base64url')}`, false);
      if (!topic) return;
      await this.storeSecret('ntfyTopic', topic);
    } else if (p.value === 'bark') {
      const url = await ask('Bark URL, e.g. https://api.day.app/yourkey', s.barkUrl);
      if (!url) return;
      await this.storeSecret('barkUrl', url);
    } else if (p.value === 'telegram') {
      const token = await ask('Telegram bot token', s.telegramBotToken);
      if (!token) return;
      const chat = await ask('Telegram chat id', s.telegramChatId, false);
      if (!chat) return;
      await this.storeSecret('telegramBotToken', token);
      await this.storeSecret('telegramChatId', chat);
    } else if (p.value === 'webhook') {
      const url = await ask('Webhook URL (receives POST JSON {title, message, kind})', s.webhookUrl);
      if (!url) return;
      await this.storeSecret('webhookUrl', url);
    }
    await this.load();
    await conf.update('provider', p.value, G);
    try {
      await push.sendPush(this.config(), { title: 'Claude Terminal connected', message: 'You will get alerts here when you are away.', kind: 'done' });
      const extra = p.value === 'ntfy' ? ' Subscribe to the same topic in the ntfy app.' : '';
      vscode.window.showInformationMessage(`Test push sent via ${p.label}.${extra}`);
    } catch (e) {
      vscode.window.showErrorMessage(`Test push failed: ${e.message}`);
    }
  }

  dispose() {
    this.cancelAll();
  }
}

module.exports = { PushService };
