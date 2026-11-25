// Astral index: the site as a navigable star graph.
import * as THREE from 'three';
import { createRenderer, createPost } from './post.js';
import { NODES, byId, childrenOf } from './graph.js';
import { createSky, createStars, createDust } from './sky.js';
import { createEdges } from './edges.js';
import { createChart } from './chart.js';
import { Rig } from './rig.js';

const q = new URLSearchParams(location.search);
const $ = s => document.querySelector(s);
const canvas = $('#scene'), body = document.body;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- renderer / scene ----------
const renderer = createRenderer(canvas);
const maxDpr = q.has('dpr') ? +q.get('dpr') : Math.min(window.devicePixelRatio || 1, 1.75);
let dpr = maxDpr; renderer.setPixelRatio(dpr);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.05, 4000);
const post = createPost(renderer, scene, camera);
const rig = new Rig(camera);

const sky = createSky(renderer); scene.add(sky.mesh);
const stars = createStars(); scene.add(stars);
const dust = createDust(); scene.add(dust);

// ---------- nodes ----------
const heroClear = { home: 3.6, star: 1.0 };
for (const n of NODES) {
  n.p = new THREE.Vector3(...n.pos); n.colorC = new THREE.Color(n.color);
  n.depth = n.parent ? (byId[n.parent].parent ? 2 : 1) : 0;
  n.clear = n.depth === 0 ? heroClear.home : n.depth === 1 ? 5.0 : heroClear.star;
}
await Promise.all(NODES.map(async n => {
  let mod, opts = n.opts;
  try { mod = await import(`./bodies/${n.body}.js`); }
  catch (e) { console.info(`body "${n.body}" not available, using a star`, e.message); mod = await import('./bodies/star.js'); opts = { color: n.color, radius: 1, seed: n.pos[0] }; }
  n.inst = mod.create(opts || {});
  n.holder = new THREE.Group(); n.holder.position.copy(n.p); if (n.rot) n.holder.rotation.set(...n.rot);
  n.holder.add(n.inst.group); scene.add(n.holder);
  if (n.inst.setEnvironment) n.inst.setEnvironment(sky.nebula);
  n.pickR = Math.min(n.inst.radius || 1, n.depth === 1 ? 3.2 : 2.2);
}));
const linked = NODES.filter(n => n.parent);
linked.forEach((n, i) => { n.edge = i; });
const edges = createEdges(linked.map(n => { const p = byId[n.parent]; return { a: p.p, b: n.p, colA: p.colorC, colB: n.colorC, clearA: p.clear, clearB: n.clear }; }));
scene.add(edges.group);
const chart = createChart(NODES); scene.add(chart.group);

// ---------- DOM ----------
const labelsEl = $('#labels'), reticle = $('#reticle'), card = $('#card'), page = $('#page'), crumbs = $('#crumbs'), coords = $('#coords');
NODES.forEach((n, i) => {
  const el = document.createElement('div'); el.className = 'label' + (n.depth === 2 ? ' minor' : ''); el.style.setProperty('--c', n.color);
  el.innerHTML = `<span class="name"></span>${n.depth < 2 ? `<span class="idx">${String(i).padStart(2, '0')} · ${n.kicker.split(' · ')[0]}</span>` : ''}`;
  el.firstChild.textContent = n.title; labelsEl.appendChild(el); n.label = el; n.labelA = 0;
});

const state = { focus: null, hover: null, mode: 'space', time: +(q.get('t') || 0), frozen: q.has('t'), shift: new THREE.Vector2(), shiftGoal: new THREE.Vector2(), warp: 0, flash: 0, cardTimer: 0 };
const wide = () => innerWidth > 760;

function setAccent(n) { document.documentElement.style.setProperty('--accent', n ? n.color : byId.home.color); }

function path(id) { const out = []; for (let n = byId[id]; n; n = byId[n.parent]) out.unshift(n); return out; }

function renderCrumbs() {
  crumbs.textContent = '';
  const add = (text, id) => { const b = document.createElement('button'); b.textContent = text; b.onclick = () => focus(id); crumbs.appendChild(b); };
  add('Map', null);
  if (state.focus) for (const n of path(state.focus)) { const s = document.createElement('i'); s.textContent = '/'; crumbs.appendChild(s); add(n.title, n.id); }
}

function renderCard(n) {
  card.querySelector('.kicker').textContent = n.kicker;
  const h = card.querySelector('h1'); h.textContent = n.title; h.classList.toggle('long', n.title.length > 7);
  card.querySelector('.desc').textContent = n.desc;
  const chips = card.querySelector('.chips'); chips.textContent = '';
  for (const c of childrenOf(n.id)) { const b = document.createElement('button'); b.textContent = c.title; b.style.setProperty('--c', c.color); b.onclick = () => focus(c.id); b.onpointerenter = () => { state.hover = c.id; }; b.onpointerleave = () => { state.hover = null; }; chips.appendChild(b); }
  $('#enter span').textContent = n.href ? 'Open' : 'Enter';
}

function activeEdges() {
  const set = new Set();
  if (state.focus) { for (const n of path(state.focus)) if (n.edge !== undefined) set.add(n.edge); for (const c of childrenOf(state.focus)) set.add(c.edge); }
  if (state.hover && byId[state.hover].edge !== undefined) set.add(byId[state.hover].edge);
  edges.setActive(set);
}

const overviewRadius = () => THREE.MathUtils.clamp(84 / Math.min(1, camera.aspect / 1.35), 84, 160);
const OV_T = new THREE.Vector3(0, 0, 0), OV_PHI = 1.3;

function viewPos(n) {
  // Stand on the far side of the star from its parent, off to one side and a little above, so the rest of
  // the graph hangs in the background behind it.
  const out = new THREE.Vector3();
  if (n.parent) out.subVectors(n.p, byId[n.parent].p).normalize();
  else out.subVectors(camera.position, n.p).setY(0).normalize();
  const up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3().crossVectors(up, out).normalize();
  const dir = n.parent ? out.multiplyScalar(0.7).addScaledVector(up, 0.3).addScaledVector(side, -0.64).normalize() : out.multiplyScalar(0.95).addScaledVector(up, 0.3).normalize();
  const dist = n.view * (camera.aspect < 1 ? 1.25 : 1);
  return dir.multiplyScalar(dist).add(n.p);
}

function focus(id, { instant = false, silent = false } = {}) {
  if (state.mode !== 'space') return;
  const n = id ? byId[id] : null;
  state.focus = id || null; state.hover = null;
  clearTimeout(state.cardTimer); card.classList.remove('open');
  setAccent(n); renderCrumbs(); activeEdges();
  if (!silent) try { history.replaceState(null, '', id ? `#${id}` : location.pathname + location.search); } catch (e) { /* sandboxed frame */ }
  let L, P;
  if (n) {
    L = n.p; P = viewPos(n); rig.minR = n.view * 0.5; rig.maxR = n.view * 3.5; rig.auto = 0.03;
    state.shiftGoal.set(wide() ? 0.16 : 0, wide() ? 0 : 0.2);
  } else {
    L = OV_T.clone(); const d = camera.position.clone().setY(0); if (d.lengthSq() < 1e-4) d.set(0, 0, 1);
    const r = overviewRadius(); P = d.normalize().multiplyScalar(r * Math.sin(OV_PHI)).setY(r * Math.cos(OV_PHI)).add(OV_T);
    rig.minR = 26; rig.maxR = 150; rig.auto = 0.022; state.shiftGoal.set(0, 0);
  }
  const dist = camera.position.distanceTo(P);
  const dur = instant ? 0 : reduced ? 0.6 : THREE.MathUtils.clamp(1.5 + dist * 0.022, 1.7, 3.2);
  if (instant) { rig.snap(L, P); state.shift.copy(state.shiftGoal); if (n) { renderCard(n); card.classList.add('open'); } return; }
  rig.flyTo(L, P, dur);
  if (n) state.cardTimer = setTimeout(() => { renderCard(n); card.classList.add('open'); }, dur * 560);
}

function enter() {
  const n = byId[state.focus]; if (!n || state.mode !== 'space') return;
  state.mode = 'diving'; card.classList.remove('open'); body.classList.add('inside');
  const dir = camera.position.clone().sub(n.p).normalize();
  rig.flyTo(n.p, n.p.clone().addScaledVector(dir, Math.max(0.12, n.pickR * 0.2)), reduced ? 0.5 : 1.35, { kind: 'dive', onDone: () => {
    if (n.href) { location.href = n.href; return; }
    state.mode = 'page'; page.querySelector('.kicker').textContent = n.kicker; page.querySelector('h1').textContent = n.title;
    page.hidden = false; $('#back').focus({ preventScroll: true });
  } });
}

function leave() {
  if (state.mode === 'space') return;
  const n = byId[state.focus]; page.hidden = true; body.classList.remove('inside');
  state.mode = 'space'; state.flash = 1; state.warp = 0.6;
  if (n) { rig.snap(n.p, n.p.clone().addScaledVector(viewPos(n).sub(n.p).normalize(), n.view * 0.45)); rig.flyTo(n.p, viewPos(n), 1.6); renderCard(n); setTimeout(() => card.classList.add('open'), 700); }
}

// ---------- input ----------
const pointers = new Map(); let downAt = null, moved = 0, pinch = 0;
const ptr = new THREE.Vector2(-1e4, -1e4);
canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 1) { downAt = [e.clientX, e.clientY]; moved = 0; rig.dragging = true; canvas.classList.add('grabbing'); }
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); }
  body.classList.add('touched');
});
canvas.addEventListener('pointermove', e => {
  ptr.set(e.clientX, e.clientY);
  if (e.pointerType === 'mouse') rig.parGoal.set((e.clientX / innerWidth - 0.5) * 2, -(e.clientY / innerHeight - 0.5) * 2);
  const prev = pointers.get(e.pointerId); if (!prev) return;
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 1) { const dx = e.clientX - prev[0], dy = e.clientY - prev[1]; moved += Math.abs(dx) + Math.abs(dy); if (moved > 5) rig.drag(dx, dy); }
  else if (pointers.size === 2) { const [a, b] = [...pointers.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch) rig.zoom(pinch / d); pinch = d; moved = 99; }
});
const up = e => {
  pointers.delete(e.pointerId); if (pointers.size) return;
  rig.dragging = false; canvas.classList.remove('grabbing');
  if (downAt && moved <= 5 && e.type === 'pointerup') { const hit = pick(e.clientX, e.clientY); if (hit) (hit === state.focus ? enter() : focus(hit)); }
  downAt = null;
};
canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
canvas.addEventListener('pointerleave', () => { ptr.set(-1e4, -1e4); });
canvas.addEventListener('wheel', e => { e.preventDefault(); rig.zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0012))); body.classList.add('touched'); }, { passive: false });
$('#home').onclick = () => focus(null); $('#enter').onclick = enter; $('#back').onclick = leave;
addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (state.mode === 'page') leave(); else if (state.focus) focus(byId[state.focus].parent || null); }
  else if (e.key === 'Enter' && state.focus && state.mode === 'space' && document.activeElement?.tagName !== 'BUTTON') enter();
  else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && state.mode === 'space') {
    const cur = state.focus ? byId[state.focus] : null; const sib = cur && cur.parent ? childrenOf(cur.parent) : childrenOf('home');
    const i = cur ? sib.indexOf(cur) : -1; focus(sib[(i + (e.key === 'ArrowRight' ? 1 : -1) + sib.length) % sib.length].id);
  }
});
addEventListener('hashchange', () => { const id = location.hash.replace(/^#\/?/, ''); if (state.mode === 'page') leave(); if (id !== (state.focus || '')) focus(byId[id] ? id : null, { silent: true }); });
addEventListener('pageshow', e => { if (e.persisted) { state.mode = 'page'; leave(); } });

// ---------- projection helpers ----------
const _v = new THREE.Vector3();
let W = innerWidth, H = innerHeight;
function project(n) {
  _v.copy(n.p).applyMatrix4(camera.matrixWorldInverse); const z = -_v.z;
  _v.applyMatrix4(camera.projectionMatrix);
  n.sx = (_v.x * 0.5 + 0.5) * W; n.sy = (-_v.y * 0.5 + 0.5) * H; n.sz = z;
  n.sr = z > 0.05 ? n.pickR / z * (H / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) : 0;
}
function pick(x, y) {
  let best = null, bestD = 1e9;
  for (const n of NODES) {
    if (n.sz <= 0.05) continue; if (n.depth === 2 && !childVisible(n)) continue;
    const r = Math.max(26, Math.min(n.sr, 170)), d = Math.hypot(n.sx - x, n.sy - y);
    if (d < r && d / r + n.sz * 1e-4 < bestD) { bestD = d / r + n.sz * 1e-4; best = n.id; }
  }
  return best;
}
const NEUTRAL = new THREE.Color(1, 1, 1), skyTint = new THREE.Color(1, 1, 1); let skyAmt = 0;
const placed = [], byDepth = [...NODES];
const childVisible = n => { const f = state.focus && byId[state.focus]; return !!f && (f.id === n.parent || f.id === n.id || f.parent === n.parent); };

function resize() {
  W = innerWidth; H = innerHeight; renderer.setPixelRatio(dpr); renderer.setSize(W, H);
  post.composer.setPixelRatio(dpr); post.setSize(W, H); camera.aspect = W / H; applyShift(true);
}
function applyShift(force) {
  const sx = Math.round(state.shift.x * W), sy = Math.round(state.shift.y * H);
  if (!force && sx === applyShift.sx && sy === applyShift.sy) return;
  applyShift.sx = sx; applyShift.sy = sy;
  if (sx || sy) camera.setViewOffset(W, H, sx, sy, W, H); else camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

// ---------- frame ----------
let last = performance.now(), ema = 16, frames = 0;
function frame(now) {
  const rawDt = (now - last) / 1000; last = now; const dt = Math.min(0.05, rawDt);
  if (!state.frozen) state.time += dt; const time = state.time;
  frames++;
  // adaptive resolution: hold 60fps on weak GPUs
  if (!q.has('dpr') && frames > 30) { ema += (rawDt * 1000 - ema) * 0.05; if (frames % 45 === 0) { const want = ema > 25 && dpr > 0.7 ? dpr * 0.85 : ema < 14 && dpr < maxDpr ? Math.min(maxDpr, dpr * 1.08) : dpr; if (want !== dpr) { dpr = want; resize(); } } }

  state.shift.lerp(state.shiftGoal, Math.min(1, dt * 2.2)); applyShift(false);
  rig.update(dt);

  const diving = rig.flight && rig.flight.kind === 'dive';
  const travel = rig.flight && rig.flight.kind === 'arc' ? Math.sin(Math.PI * rig.progress) : 0;
  if (diving) { state.warp = rig.progress ** 3; state.flash = THREE.MathUtils.smoothstep(rig.progress, 0.72, 1) * 1.6; }
  else if (state.mode === 'page') { state.warp = 1; state.flash = 1.6; }
  else { state.warp += (0 - state.warp) * Math.min(1, dt * 3); state.flash += (0 - state.flash) * Math.min(1, dt * 2.6); }
  post.final.uniforms.uWarp.value = state.warp + travel * 0.07; post.final.uniforms.uFlash.value = state.flash;

  const pxH = H * dpr; const f0 = state.focus && byId[state.focus];
  for (const n of NODES) n.inst.update(time, dt, camera);
  skyTint.lerp(f0 ? f0.colorC : NEUTRAL, Math.min(1, dt * 1.2)); sky.update(time, skyTint, skyAmt += ((f0 ? 1 : 0) - skyAmt) * Math.min(1, dt * 1.2), pxH);
  stars.position.copy(camera.position); stars.material.uniforms.uTime.value = time; stars.material.uniforms.uPx.value = dpr * Math.max(1, H / 900);
  dust.material.uniforms.uTime.value = time; dust.material.uniforms.uScale.value = pxH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  activeEdges(); edges.update(time, dt, camera, pxH); chart.update(dust.material.uniforms.uScale.value);

  if (state.mode !== 'page') post.render(time);

  // overlays
  for (const n of NODES) project(n);
  const hoverId = state.mode === 'space' && !rig.dragging && pointers.size === 0 ? pick(ptr.x, ptr.y) : null;
  if (ptr.x > -1e3) state.hover = hoverId;
  canvas.classList.toggle('pointing', !!hoverId);
  const f = state.focus && byId[state.focus];
  const fr = f ? Math.min(f.sr * (f.inst.radius || 1) / f.pickR, H * 0.42) * 1.15 : 0;
  placed.length = 0;
  for (const n of byDepth.sort((a, b) => a.sz - b.sz)) {
    let a = 0;
    if (state.mode === 'space' && n.sz > 0.05) {
      if (n.depth === 2) a = childVisible(n) ? 0.92 : 0; else a = f ? 0.3 : 1;
      if (f && W > 760 && n.sx > W * 0.6) a = 0;
      if (f && n.id === f.id) a = 0;
      if (n.id === state.hover) a = n.id === state.focus ? 0 : 1;
    }
    // keep labels on screen, off the focused body, and off each other (nearest label wins its spot)
    const lw = n.depth === 2 ? 120 : 190, lh = n.depth === 2 ? 30 : 46;
    let x = Math.max(lw / 2 + 8, Math.min(W - lw / 2 - 8, n.sx)), y = n.sy + Math.min(n.sr, 150) + 10;
    if (a > 0 && n.id !== state.hover && (Math.abs(x - n.sx) > 1 || y < 96 || y > H - 96)) a = 0; // off-screen or under the HUD
    if (a > 0 && f && n.id !== state.hover && Math.hypot(x - f.sx, y + lh / 2 - f.sy) < fr) a = 0;
    if (a > 0) {
      for (let k = 0; k < 3; k++) for (const b of placed) if (Math.abs(x - b.x) < (lw + b.w) / 2 && y < b.y + b.h + 4 && y + lh > b.y - 4) y = b.y + b.h + 6;
      if (y > n.sy + Math.min(n.sr, 150) + 90) a *= 0.4;
      placed.push({ x, y, w: lw, h: lh });
    }
    n.labelA += (a - n.labelA) * Math.min(1, dt * 6);
    const s = n.label.style;
    if (n.labelA < 0.01) { if (s.opacity !== '0') s.opacity = '0'; continue; }
    s.opacity = n.labelA.toFixed(3);
    n.ly = n.ly === undefined || n.labelA < 0.05 ? y : n.ly + (y - n.ly) * Math.min(1, dt * 8);
    s.transform = `translate3d(${x.toFixed(1)}px,${n.ly.toFixed(1)}px,0) translateX(-50%)`;
    n.label.classList.toggle('hot', n.id === state.hover);
  }
  const h = state.hover && byId[state.hover];
  if (h && state.mode === 'space') {
    const size = Math.max(52, Math.min(h.sr, 170) * 2 + 26);
    reticle.style.width = reticle.style.height = size + 'px';
    reticle.style.transform = `translate3d(${(h.sx - size / 2).toFixed(1)}px,${(h.sy - size / 2).toFixed(1)}px,0)`;
    reticle.style.setProperty('--c', h.color); reticle.lastElementChild.textContent = h.id === state.focus ? (h.href ? 'Open' : 'Enter') : '';
    reticle.classList.add('on');
  } else reticle.classList.remove('on');

  if (frames % 6 === 0) {
    const az = ((rig.theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), ra = az / (2 * Math.PI) * 24, dec = 90 - rig.phi * 180 / Math.PI;
    const d = camera.position.distanceTo(rig.look);
    coords.textContent = `RA ${String(Math.floor(ra)).padStart(2, '0')}h ${String(Math.floor(ra % 1 * 60)).padStart(2, '0')}m   DEC ${dec >= 0 ? '+' : '−'}${Math.abs(dec).toFixed(1).padStart(4, '0')}°   ${d.toFixed(1).padStart(5, ' ')} AU`;
  }
  window.__frames = frames;
  requestAnimationFrame(frame);
}

// ---------- boot ----------
resize(); renderCrumbs();
const startId = q.get('focus') || location.hash.replace(/^#\/?/, '');
const overview = () => { const r = overviewRadius(), th = +(q.get('theta') || 0.75); return new THREE.Vector3(r * Math.sin(OV_PHI) * Math.sin(th), r * Math.cos(OV_PHI), r * Math.sin(OV_PHI) * Math.cos(th)).add(OV_T); };
if (q.get('intro') === '0' || reduced) {
  rig.snap(OV_T.clone(), overview()); rig.update(0);
  if (byId[startId]) focus(startId, { instant: true, silent: true });
} else {
  rig.snap(OV_T.clone(), overview().multiplyScalar(4.2).applyAxisAngle(new THREE.Vector3(0, 1, 0), -1.5));
  rig.flyTo(OV_T.clone(), overview(), 4.6, { onDone: () => { if (byId[startId]) focus(startId, { silent: true }); } });
}
if (q.has('still')) rig.auto = 0;
window.__astral = { focus, enter, leave, rig, state, NODES };
requestAnimationFrame(now => { last = now; body.classList.remove('booting'); frame(now); });
