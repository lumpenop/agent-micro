const fs = require('fs');
const path = require('path');

const root = __dirname;
const out = path.join(root, 'dist');
const assets = path.join(out, 'assets');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(assets, { recursive: true });
for (const name of ['index.html', 'styles.css', 'script.js']) {
  fs.copyFileSync(path.join(root, name), path.join(out, name));
}
const downloadUrl = String(process.env.AGENT_MICRO_DOWNLOAD_URL || '').trim();
fs.writeFileSync(path.join(out, 'config.js'), `window.AGENT_MICRO_DOWNLOAD_URL = ${JSON.stringify(downloadUrl)};\n`);
for (const name of fs.readdirSync(path.join(root, 'assets'))) {
  fs.copyFileSync(path.join(root, 'assets', name), path.join(assets, name));
}
console.log(`Landing build ready: ${out}`);
