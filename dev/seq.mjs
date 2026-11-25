// Frame sequence: node dev/seq.mjs "<url>" <outPrefix> "<js to run after load>" [count=6] [intervalMs=700] [w=1280] [h=720]
// Runs the JS once the scene is rendering (e.g. "__astral.focus('riddles')"), then saves count screenshots.
// The software renderer is slow, so animations play in slow motion here; judge shape and continuity, not speed.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p); if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
}).listen(0);
const [url, prefix, js = '', count = 6, interval = 700, w = 1280, h = 720] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
page.on('console', m => { if (m.type() === 'error') console.log('[error]', m.text()); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(`http://localhost:${server.address().port}/${url.replace(/^\//, '')}`);
await page.waitForFunction(() => (window.__frames || 0) >= 4, null, { timeout: 120000 });
if (js) await page.evaluate(js);
for (let i = 0; i < +count; i++) { await page.waitForTimeout(+interval); const out = `${prefix}-${i}.png`; await page.screenshot({ path: out }); console.log('wrote', out); }
await browser.close(); server.close();
