// Orbit sweep: node dev/sweep.mjs <outPrefix> [count=24] [w=640] [h=360] — steps the overview camera through angles and zooms, one screenshot each.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html'; const f = path.join(root, p); if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(0);
const [prefix, count = 24, w = 640, h = 360] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(`http://localhost:${server.address().port}/index.html?intro=0&dpr=1&still`);
await page.waitForFunction(() => (window.__frames || 0) >= 3, null, { timeout: 180000 });
for (let i = 0; i < +count; i++) {
  const f0 = await page.evaluate(i => { const r = __astral.rig; r.theta = i * 0.53; r.phi = 0.35 + ((i * 0.37) % 1) * 2.3; r.radius = r.radiusGoal = 30 + ((i * 0.61) % 1) * 110; return window.__frames; }, i);
  await page.waitForFunction(n => window.__frames >= n + 2, f0, { timeout: 120000 });
  await page.screenshot({ path: `${prefix}-${String(i).padStart(2, '0')}.png` });
}
await browser.close(); server.close(); console.log('done');
