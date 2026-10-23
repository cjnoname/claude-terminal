// Prints whether package.json's version is newer than the one on the VS Code Marketplace.
// Used by the release workflow: writes `publish=true|false` and `version=x.y.z` to $GITHUB_OUTPUT.
const fs = require('fs');
const { execFileSync } = require('child_process');
const pkg = require('../package.json');

function parse(v) {
  return String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
}

function newer(a, b) {
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

let published = '0.0.0';
try {
  const out = execFileSync('npx', ['-y', '@vscode/vsce', 'show', `${pkg.publisher}.${pkg.name}`, '--json'], { encoding: 'utf-8' });
  published = JSON.parse(out).versions[0].version;
} catch (e) {
  console.error(`Could not read the Marketplace version (${e.message.split('\n')[0]}); assuming the extension is not published yet.`);
}

const publish = newer(pkg.version, published);
console.log(`package.json ${pkg.version} vs Marketplace ${published} → ${publish ? 'publish' : 'skip'}`);
if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\nversion=${pkg.version}\n`);
}
