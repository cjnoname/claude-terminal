// "Choose Alert Sound…" picker with live preview.
const vscode = require('vscode');
const sound = require('../sound');

const KINDS = [
  { label: '$(pass-filled) Task finished', kind: 'done' },
  { label: '$(bell-dot) Needs your input', kind: 'attention' },
];

/** @param {string} placeHolder */
async function pickKind(placeHolder) {
  return (await vscode.window.showQuickPick(KINDS, { placeHolder }))?.kind;
}

/**
 * @param {{cfg: (key: string) => any, play: (kind: string) => void, run: (cmd: string, label: string) => void}} deps
 */
async function chooseSound({ cfg, play, run }) {
  const kind = await pickKind('Choose the sound for…');
  if (!kind) return;
  const conf = vscode.workspace.getConfiguration('claudeTerminal');
  const current = conf.get(`sound.${kind}.name`);
  const items = [
    ...(process.platform === 'darwin'
      ? sound.MAC_SOUNDS.map((s) => ({ label: s, value: s, description: s === current ? 'current' : '' }))
      : [{ label: 'System default', value: '__default__' }]),
    { label: '$(file-media) Custom file…', value: '__custom__' },
  ];
  const qp = vscode.window.createQuickPick();
  qp.items = items;
  qp.placeholder = 'Arrow keys preview the sound, Enter selects';
  const active = items.find((i) => i.value === current);
  if (active) qp.activeItems = [active];
  qp.onDidChangeActive(([item]) => {
    if (item && process.platform === 'darwin' && sound.MAC_SOUNDS.includes(item.value)) {
      run(sound.buildPlayCommand({ platform: 'darwin', kind, name: item.value, volume: (Number(cfg('sound.volume')) || 50) / 100 }), 'Preview');
    }
  });
  qp.onDidAccept(async () => {
    const item = qp.selectedItems[0];
    qp.hide();
    if (!item) return;
    const G = vscode.ConfigurationTarget.Global;
    if (item.value === '__custom__') {
      const uri = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Audio: ['wav', 'aiff', 'aif', 'mp3', 'm4a', 'ogg', 'oga', 'wma'] } });
      if (!uri) return;
      await conf.update(`sound.${kind}.customFile`, uri[0].fsPath, G);
    } else {
      await conf.update(`sound.${kind}.customFile`, '', G);
      if (item.value !== '__default__') await conf.update(`sound.${kind}.name`, item.value, G);
    }
    play(kind);
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

module.exports = { chooseSound, pickKind };
