// Builds platform-specific shell commands for sounds, speech and desktop notifications.
const MAC_SOUNDS = ['Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero', 'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink'];

const WIN_DEFAULTS = {
  done: 'C:\\Windows\\Media\\Windows Notify System Generic.wav',
  attention: 'C:\\Windows\\Media\\Windows Exclamation.wav',
};
const LINUX_DEFAULTS = {
  done: '/usr/share/sounds/freedesktop/stereo/complete.oga',
  attention: '/usr/share/sounds/freedesktop/stereo/dialog-warning.oga',
};

function psEncoded(script) {
  return `powershell -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {{platform: string, kind: 'done'|'attention', file?: string, name?: string, volume: number}} o volume 0..1
 */
function buildPlayCommand({ platform, kind, file, name, volume }) {
  const v = Math.max(0, Math.min(1, volume));
  if (platform === 'darwin') {
    const target = file || `/System/Library/Sounds/${MAC_SOUNDS.includes(name) ? name : 'Glass'}.aiff`;
    return `afplay -v ${v.toFixed(2)} ${shQuote(target)}`;
  }
  if (platform === 'win32') {
    const target = file || WIN_DEFAULTS[kind] || WIN_DEFAULTS.done;
    return psEncoded([
      'Add-Type -AssemblyName PresentationCore',
      '$p = New-Object System.Windows.Media.MediaPlayer',
      `$p.Open([Uri]${psQuote(target)})`,
      `$p.Volume = ${v.toFixed(2)}`,
      '$p.Play()',
      '$t = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $t -lt 20) { Start-Sleep -Milliseconds 100; $t++ }',
      'if ($p.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds ([int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 100) } else { Start-Sleep 2 }',
    ].join('; '));
  }
  const q = shQuote(file || LINUX_DEFAULTS[kind] || LINUX_DEFAULTS.done);
  return `paplay --volume=${Math.round(v * 65536)} ${q} 2>/dev/null || pw-play --volume=${v.toFixed(2)} ${q} 2>/dev/null || aplay -q ${q} 2>/dev/null || printf '\\a'`;
}

function buildSpeakCommand(platform, text) {
  if (platform === 'darwin') return `say ${shQuote(text)}`;
  if (platform === 'win32') {
    return psEncoded(`Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak(${psQuote(text)})`);
  }
  return `spd-say ${shQuote(text)} 2>/dev/null || espeak ${shQuote(text)} 2>/dev/null || true`;
}

function buildSystemNotificationCommand(platform, title, message) {
  if (platform === 'darwin') {
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `display notification "${esc(message)}" with title "${esc(title)}"`;
    return `osascript -e ${shQuote(script)}`;
  }
  if (platform === 'win32') {
    const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEsc(title)}</text><text>${xmlEsc(message)}</text></binding></visual></toast>`;
    return psEncoded([
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
      '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
      `$x.LoadXml(${psQuote(xml)})`,
      "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
    ].join('; '));
  }
  return `notify-send -a 'Claude Terminal' -- ${shQuote(title)} ${shQuote(message)} 2>/dev/null || true`;
}

module.exports = { MAC_SOUNDS, buildPlayCommand, buildSpeakCommand, buildSystemNotificationCommand, psEncoded, shQuote };
