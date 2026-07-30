const fs = require('fs');
const path = require('path');

const root = __dirname;
const out = path.join(root, 'dist');
const assets = path.join(out, 'assets');
const client = path.join(out, 'client');
const clientAssets = path.join(client, 'assets');
const server = path.join(out, 'server');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(assets, { recursive: true });
fs.mkdirSync(clientAssets, { recursive: true });
fs.mkdirSync(server, { recursive: true });
for (const name of ['index.html', 'styles.css', 'quality.css', 'product.css', 'script.js', 'robots.txt', 'sitemap.xml']) {
  fs.copyFileSync(path.join(root, name), path.join(out, name));
  fs.copyFileSync(path.join(root, name), path.join(client, name));
}
const downloadUrl = String(process.env.AGENT_MICRO_DOWNLOAD_URL || '').trim();
fs.writeFileSync(path.join(out, 'config.js'), `window.AGENT_MICRO_DOWNLOAD_URL = ${JSON.stringify(downloadUrl)};\n`);
fs.writeFileSync(path.join(client, 'config.js'), `window.AGENT_MICRO_DOWNLOAD_URL = ${JSON.stringify(downloadUrl)};\n`);
for (const name of fs.readdirSync(path.join(root, 'assets'))) {
  fs.copyFileSync(path.join(root, 'assets', name), path.join(assets, name));
  fs.copyFileSync(path.join(root, 'assets', name), path.join(clientAssets, name));
}
fs.writeFileSync(path.join(server, 'index.js'), `const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
    let response = await env.ASSETS.fetch(new Request(new URL(requestedPath, url), request));
    if (response.status === 404 && !requestedPath.split('/').pop().includes('.')) {
      response = await env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    }
    return response;
  },
};

export default worker;
`);
console.log(`Landing build ready: ${out}`);
