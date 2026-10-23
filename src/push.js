// Mobile / remote push: ntfy, Bark, Telegram or a generic webhook.

/**
 * @param {object} cfg push settings
 * @param {{title: string, message: string, kind: string, project: string, sessionId: string}} n
 * @returns {{url: string, init: RequestInit} | null}
 */
function buildPushRequest(cfg, n) {
  const json = (url, body) => ({
    url,
    init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  });
  switch (cfg.provider) {
    case 'ntfy': {
      if (!cfg.ntfyTopic) return null;
      const server = (cfg.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '');
      const req = json(server, {
        topic: cfg.ntfyTopic,
        title: n.title,
        message: n.message || n.title,
        tags: [n.kind === 'attention' ? 'warning' : 'white_check_mark'],
        priority: n.kind === 'attention' ? 4 : 3,
      });
      if (cfg.ntfyToken) req.init.headers.Authorization = `Bearer ${cfg.ntfyToken}`;
      return req;
    }
    case 'bark':
      if (!cfg.barkUrl) return null;
      return json(cfg.barkUrl.replace(/\/+$/, ''), {
        title: n.title, body: n.message || n.title, group: 'Claude',
        level: n.kind === 'attention' ? 'timeSensitive' : 'active',
      });
    case 'telegram':
      if (!cfg.telegramBotToken || !cfg.telegramChatId) return null;
      return json(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
        chat_id: cfg.telegramChatId,
        text: `${n.kind === 'attention' ? '⚠️' : '✅'} ${n.title}\n${n.message || ''}`.trim(),
        disable_web_page_preview: true,
      });
    case 'webhook':
      if (!cfg.webhookUrl) return null;
      return json(cfg.webhookUrl, { ...n, source: 'claude-terminal', at: new Date().toISOString() });
    default:
      return null;
  }
}

/** What a push says. 'generic' leaks nothing about the code; 'project' adds the folder name; 'full' adds the summary/command. */
function shapeContent(mode, { kind, project, message }) {
  const base = kind === 'attention' ? 'Claude needs your input' : 'Claude finished';
  if (mode === 'full') return { title: project ? `${base} · ${project}` : base, message: message || base };
  if (mode === 'project') return { title: project ? `${base} · ${project}` : base, message: kind === 'attention' ? 'Waiting for you in VS Code' : 'Task complete' };
  return { title: base, message: kind === 'attention' ? 'Waiting for you in VS Code' : 'Task complete' };
}

async function sendPush(cfg, n, fetchImpl = globalThis.fetch) {
  const req = buildPushRequest(cfg, n);
  if (!req) throw new Error('Push is not configured (check provider settings).');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetchImpl(req.url, { ...req.init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { buildPushRequest, sendPush, shapeContent };
