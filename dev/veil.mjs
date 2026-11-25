// Captures the loading screen and its opening: node dev/veil.mjs <outPrefix> [w h]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html'; const f = path.join(root, p); if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(0);
const [prefix, w = 1280, h = 720] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
page.on('console', m => { if (m.type() === 'error') console.log('[error]', m.text()); }); page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(`http://localhost:${server.address().port}/index.html?dpr=1`, { waitUntil: 'commit' });
let i = 0; const snap = async () => { await page.screenshot({ path: `${prefix}-${i++}.png` }); };
await page.waitForTimeout(900); await snap(); await page.waitForTimeout(1200); await snap();
await page.waitForFunction(() => !document.body.classList.contains('booting'), null, { timeout: 120000 });
await page.waitForTimeout(250); await snap(); await page.waitForTimeout(500); await snap(); await page.waitForTimeout(1500); await snap();
await browser.close(); server.close(); console.log('done', i);
