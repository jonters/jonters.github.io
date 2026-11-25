// Ambient decor: the deep-space scenery around the graph. Distant particle galaxies, soft nebula complexes and
// filaments, star clusters and a mid-ground star layer, a slow debris stream lit by the sun, two comets with
// ion and dust tails, rare meteor streaks and a distant ringed planet. Non-interactive and kept dim (below the
// bloom threshold apart from tiny cores) so the graph stays the brightest thing on screen. Everything animates
// as a pure function of `time` in vertex shaders.
// createAmbient({ nodes, environment }) -> { group, update(time, dt, camera, viewportHeightPx) }
import * as THREE from 'three';
import { NOISE } from './glsl.js';

// ---------- helpers ----------
function rng(seed) {
  let a = (Math.floor(seed * 9973) ^ 0x2545f491) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
// rig convention: azimuth a -> (sin a, ., cos a)
const at = (az, dist, y) => V3(dist * Math.sin(az), y, dist * Math.cos(az));
const gauss = r => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
const randDir = r => { const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z); return V3(Math.cos(a) * s, z, Math.sin(a) * s); };
const col = (h, k = 1) => new THREE.Color(h).multiplyScalar(k);
// orientation whose local +Y is a disk normal inclined `incl` from the line of sight from the origin, rolled by `pa`
function diskQuat(pos, incl, pa) {
  const los = pos.clone().normalize();
  const ref = Math.abs(los.y) > 0.9 ? V3(1, 0, 0) : V3(0, 1, 0);
  const p1 = V3().crossVectors(los, ref).normalize(), p2 = V3().crossVectors(los, p1);
  const perp = p1.multiplyScalar(Math.cos(pa)).addScaledVector(p2, Math.sin(pa));
  const n = los.multiplyScalar(Math.cos(incl)).addScaledVector(perp, Math.sin(incl)).normalize();
  return new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), n);
}
// decor that lands near the middle of the frame sits behind whatever the camera is looking at: dim it there
const CF = /* glsl */ `
uniform float uCF, uCard;
float centerFadeK(vec3 wp,float k){
  vec3 v=(viewMatrix*vec4(wp,1.0)).xyz; if(v.z>-1.0) return 1.0;
  float e=length((v.xy/(-v.z))/(vec2(0.42,0.38)*k));   // elliptical cone around the optical axis, where the graph sits
  // in a focused view the info card covers the right of the frame: keep decor out from behind its text
  vec4 cp=projectionMatrix*vec4(v,1.0);
  vec2 ndc=cp.xy/cp.w;
  float card=1.0-uCard*0.88*smoothstep(0.0,0.3,ndc.x);
  // the site title sits top-left: keep decor out from behind it
  card*=1.0-0.8*(1.0-smoothstep(-0.75,-0.55,ndc.x))*smoothstep(0.6,0.8,ndc.y);
  return mix(1.0,mix(0.14,1.0,smoothstep(0.5,1.0,e))*card,uCF);
}
float centerFade(vec3 wp){ return centerFadeK(wp,1.0); }`;
const additive = { transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending };

// ---------- layout (az radians in the rig's convention, horizontal distance, height) ----------
const L = {
  // galaxies: placed high or low in the overview frame so they sit beside the graph rather than behind it
  g1: { pos: at(3.45, 235, -185), R: 46, incl: 1.0, pa: 0.5, seed: 11 },  // grand-design spiral, warm core, blue arms
  g2: { pos: at(0.55, 225, 36), R: 34, incl: 1.45, pa: 2.2, seed: 23 },   // near edge-on lenticular with a dust lane
  g3: { pos: at(5.3, 260, -120), R: 28, incl: 0.6, pa: 4.0, seed: 37 },   // small barred spiral, cooler
  g4: { pos: V3(135, -235, -70), R: 30, incl: 0.3, pa: 1.0, seed: 53 },    // faint face-on flocculent spiral far below the chart
  // ringed planet
  planet: { pos: at(1.95, 120, -90), R: 5.5, tilt: [1.2, 0.0, 0.3] },
  // star clusters
  glob1: { pos: at(4.55, 185, 40), R: 5 },
  glob2: { pos: at(2.45, 235, -118), R: 6 },
  open1: { pos: at(0.05, 150, -78), R: 7 },
  // debris stream: an arc of an inclined orbit around the sun, centred low on one side
  belt: { R: 68, az: 4.0, elev: -0.3, roll: 0.5, width: 5, thick: 2.2, span: 2.4 },
};

// ======================================================================================================
// Galaxies: one Points draw call each (disk stars, diffuse arm light, HII knots, bulge), rotated in the shader.
// ======================================================================================================
const galVert = /* glsl */ `
attribute vec4 aData; // x world size, y brightness, z phase, w kind (0 star, 1 diffuse, 2 knot, 3 bulge)
attribute vec3 aColor;
uniform float uTime, uPixH, uGain, uSpin;
varying vec3 vCol; varying float vSoft;
${CF}
void main(){
  vec3 p=position;
  float r=length(p.xz);
  float ang=-uTime*uSpin*(1.0+0.6/(1.0+r*0.15));
  float c=cos(ang), s=sin(ang); p.xz=mat2(c,-s,s,c)*p.xz;
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  float d=-mv.z;
  float px=aData.x*uPixH/max(d,0.1);
  float pc=max(px,1.3);
  float fold=min(1.0,(px*px)/(pc*pc));
  float b=aData.y*uGain*(aData.w==0.0 || aData.w==2.0 ? mix(1.0,fold,0.55) : fold);
  b*=smoothstep(6.0,30.0,d)*centerFade(modelMatrix[3].xyz);
  gl_PointSize=min(pc,40.0);
  vCol=aColor*b; vSoft=aData.w==1.0 ? 2.6 : 7.0;
  gl_Position=projectionMatrix*mv;
  if(b<1e-4) gl_Position=vec4(2.0,2.0,2.0,1.0);
}`;
const galFrag = /* glsl */ `
varying vec3 vCol; varying float vSoft;
void main(){ vec2 c=gl_PointCoord*2.0-1.0; float r2=dot(c,c); if(r2>1.0) discard; gl_FragColor=vec4(vCol*exp(-r2*vSoft)*(1.0-r2),1.0); }`;

function makeGalaxy(o) {
  const r = rng(o.seed);
  const R = 1; // built in unit radius, scaled by the object
  const P = [], D = [], C = [];
  const push = (x, y, z, size, b, kind, c) => { P.push(x, y, z); D.push(size, b, r() * 10, kind); C.push(c.r, c.g, c.b); };
  const m = o.arms, tp = Math.tan(o.pitch), r0 = 0.12, rb = o.bulge;
  const wrap = x => Math.atan2(Math.sin(x), Math.cos(x));
  const armPhase = (rad, th) => m * (th - Math.log(Math.max(rad, 0.02) / r0) / tp);
  const cBulge = col(o.cBulge), cInner = col(o.cInner), cArm = col(o.cArm), cKnot = col(o.cKnot), cDust = col('#ffcf9a');
  const tmp = new THREE.Color();
  const density = (rad, th) => {
    if (o.armAmp <= 0) return 1;
    const ph = armPhase(rad, th);
    const crest = Math.pow(0.5 + 0.5 * Math.cos(ph), o.armSharp);
    const armW = o.armAmp * THREE.MathUtils.smoothstep(rad, rb * 0.7, rb * 1.8) * (1 - 0.5 * THREE.MathUtils.smoothstep(rad, 0.8, 1.0));
    let dd = (1 - armW) + armW * crest;
    // dust lane on the concave (inner) side of each arm
    const lane = Math.exp(-Math.pow(wrap(ph - o.laneOff), 2) / 0.07);
    dd *= 1 - o.lane * lane * THREE.MathUtils.smoothstep(rad, rb * 0.6, rb * 1.5);
    return dd;
  };
  // disk stars
  let n = 0;
  while (n < o.nStars) {
    const rad = -o.h * Math.log(r() * r() + 1e-9) * 0.5 * 1.3; if (rad > R) continue;
    let th = r() * Math.PI * 2;
    if (o.bar && rad < o.bar && r() < 0.6) th = (r() < 0.5 ? 0 : Math.PI) + gauss(r) * 0.18 * (o.bar / Math.max(rad, 0.05)) * 0.3;
    const dd = density(rad, th); if (r() > dd) continue;
    const crest = o.armAmp > 0 ? Math.pow(0.5 + 0.5 * Math.cos(armPhase(rad, th)), 2) : 0;
    let y = gauss(r) * o.thick * (0.6 + rad);
    if (o.midLane) { const lane = Math.exp(-y * y / (o.midLane * o.midLane)) * THREE.MathUtils.smoothstep(rad, 0.12, 0.3) * (1 - THREE.MathUtils.smoothstep(rad, 0.8, 1.0)); if (r() < 0.93 * lane) continue; }
    tmp.copy(cInner).lerp(cArm, THREE.MathUtils.smoothstep(rad, rb * 0.8, 0.7) * (0.35 + 0.65 * crest));
    if (r() < 0.12) tmp.lerp(cDust, 0.5);
    const fall = 0.55 + 0.45 * Math.exp(-rad * 2.2);
    push(rad * Math.cos(th), y, rad * Math.sin(th), 0.0065 + r() * 0.006, (0.35 + r() * 0.65) * fall * (0.7 + 0.6 * crest), 0, tmp);
    n++;
  }
  // diffuse arm light: larger soft points following the same density
  n = 0;
  while (n < o.nDiffuse) {
    const rad = -o.h * Math.log(r() * r() + 1e-9) * 0.5 * 1.3; if (rad > R * 0.95 || rad < rb * 0.4) continue;
    const th = r() * Math.PI * 2; const dd = density(rad, th); if (r() > dd * dd) continue;
    const crest = o.armAmp > 0 ? Math.pow(0.5 + 0.5 * Math.cos(armPhase(rad, th)), 2) : 0.5;
    tmp.copy(cInner).lerp(cArm, THREE.MathUtils.smoothstep(rad, rb, 0.75) * (0.5 + 0.5 * crest));
    let y = gauss(r) * o.thick * 0.6;
    if (o.midLane && Math.abs(y) < o.midLane * 1.2 && rad > 0.15 && rad < 0.85) y = Math.sign(y || 1) * (o.midLane * (1.2 + r()));
    push(rad * Math.cos(th), y, rad * Math.sin(th), 0.05 + r() * 0.05, 0.11 * (0.5 + crest) * (0.6 + 0.4 * Math.exp(-rad * 2)), 1, tmp);
    n++;
  }
  // HII knots on the arm crests
  for (let k = 0; k < o.nKnots; k++) {
    let rad, th, tries = 0;
    do { rad = rb * 1.3 + r() * (0.85 - rb * 1.3); th = r() * Math.PI * 2; tries++; } while (tries < 50 && Math.cos(armPhase(rad, th) + 0.35) < 0.85);
    const cnt = 4 + Math.floor(r() * 9), sz = 0.012 + r() * 0.02;
    for (let j = 0; j < cnt; j++) {
      const rr = rad + gauss(r) * sz, tt = th + gauss(r) * sz / rad;
      tmp.copy(cKnot).lerp(cArm, r() * 0.35);
      push(rr * Math.cos(tt), gauss(r) * o.thick * 0.5, rr * Math.sin(tt), 0.008 + r() * 0.008, 0.9 + r() * 0.8, 2, tmp);
    }
  }
  // bulge (slightly triaxial along the bar)
  for (let k = 0; k < o.nBulge; k++) {
    const s = Math.pow(r(), 1.8);
    const v = randDir(r).multiplyScalar(rb * s * 1.6);
    v.y *= o.bulgeFlat; if (o.bar) v.x *= 1.5;
    tmp.copy(cBulge).lerp(cInner, s * 0.6);
    push(v.x, v.y, v.z, 0.006 + r() * 0.006, 0.55 + 0.6 * (1 - s), 3, tmp);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('aData', new THREE.Float32BufferAttribute(D, 4));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(C, 3));
  const mat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uPixH: { value: 800 }, uGain: { value: o.gain }, uSpin: { value: o.spin } }, vertexShader: galVert, fragmentShader: galFrag, ...additive });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.position.copy(o.pos); pts.quaternion.copy(diskQuat(o.pos, o.incl, o.pa)); pts.scale.setScalar(o.R);
  pts.renderOrder = -5;
  return { pts, mat, count: P.length / 3 };
}

// Galaxy disks: the unresolved light as a world-space quad in each disk plane: log-spiral arms that turn with
// the particles, flocculent breakup, star-forming knots, a warm bulge, and dust lanes that absorb (premultiplied
// alpha) on the near half of the disk, so the lanes cross in front of the bulge. One instanced draw call.
const diskVert = /* glsl */ `
attribute vec3 iCenter; attribute vec3 iU; attribute vec3 iV;
attribute vec4 iA;  // arms, tan(pitch), arm contrast, spiral-lane strength
attribute vec4 iB;  // scale length, bulge radius, spin, seed
attribute vec4 iD;  // dust ring radius, dust ring strength, bar length, gain
attribute vec3 iCB; attribute vec3 iCA; attribute vec3 iCK;
uniform float uTime;
varying vec2 vQ; varying vec4 vA; varying vec4 vB; varying vec4 vD; varying vec3 vCB; varying vec3 vCA; varying vec3 vCK; varying float vF; varying float vNear;
${CF}
void main(){
  vQ=position.xy;
  vec3 w=iCenter+iU*vQ.x+iV*vQ.y;
  vec3 toCam=cameraPosition-iCenter;
  vNear=dot(w-iCenter,normalize(toCam));
  float d=length(toCam);
  vF=smoothstep(length(iU)*0.6,length(iU)*1.6+10.0,d)*centerFade(iCenter)*iD.w;
  vA=iA; vB=iB; vD=iD; vCB=iCB; vCA=iCA; vCK=iCK;
  gl_Position=projectionMatrix*viewMatrix*vec4(w,1.0);
  if(vF<0.002) gl_Position=vec4(2.0,2.0,2.0,1.0);
}`;
const diskFrag = /* glsl */ `
uniform float uTime;
varying vec2 vQ; varying vec4 vA; varying vec4 vB; varying vec4 vD; varying vec3 vCB; varying vec3 vCA; varying vec3 vCK; varying float vF; varying float vNear;
${NOISE}
void main(){
  float r=length(vQ); if(r>1.0) discard;
  float arms=vA.x, tp=vA.y, amp=vA.z, laneS=vA.w, h=vB.x, rb=vB.y, spin=vB.z, seed=vB.w;
  float th=atan(vQ.y,vQ.x)+uTime*spin*(1.0+0.6/(1.0+r*0.15));
  vec2 rq=vec2(cos(th),sin(th))*r; // co-rotating coordinates
  // bar: stretch the inner disk along x
  float barL=vD.z;
  float ph=arms*(th-log(max(r,0.03)/0.12)/tp);
  float n=snoise(vec3(rq*5.0,seed));
  float n2=snoise(vec3(rq*13.0,seed+4.0));
  float crest=pow(0.5+0.5*cos(ph+0.5*n),2.2);
  float armW=amp*smoothstep(rb*0.7,rb*2.0,r)*(1.0-0.4*smoothstep(0.75,1.0,r));
  float disk=exp(-r/h)*((1.0-armW)+armW*crest*(0.75+0.5*n));
  disk*=0.85+0.3*n2;
  float lane=pow(0.5+0.5*cos(ph-0.85+0.3*n),18.0)*laneS*smoothstep(rb*0.5,rb*1.4,r)*(1.0-smoothstep(0.7,1.0,r));
  float ring=vD.y*exp(-pow((r-vD.x)/0.09,2.0))*(0.75+0.25*n);
  float bx=barL>0.0 ? exp(-(rq.x*rq.x)/(barL*barL)-(rq.y*rq.y)/(rb*rb*0.12)) : 0.0;
  float bul=exp(-r*r/(rb*rb*0.55))+0.5*bx;
  vec3 c=mix(vCB,vCA,smoothstep(rb*1.2,0.65,r)*(0.35+0.65*crest))*disk*(1.0-0.85*lane)*(1.0-0.8*ring);
  c+=vCB*bul*0.85+vec3(1.0,0.93,0.82)*exp(-r*r/(rb*rb*0.012))*0.7;
  c+=vCK*smoothstep(0.45,0.9,n2)*crest*armW*exp(-r/(h*1.3))*1.6;
  c*=smoothstep(1.0,0.75,r);
  // absorption on the near half only (the far half's lanes sit behind the bulge)
  float near=smoothstep(-0.02,0.08,vNear/max(length(vQ),1e-3)*r);
  float a=clamp((lane*0.55+ring*0.8)*near*smoothstep(1.0,0.6,r),0.0,0.85);
  gl_FragColor=vec4(c*vF,a*min(vF*3.0,1.0));
}`;

function createDisks(gals) {
  const n = gals.length, base = new THREE.PlaneGeometry(2, 2);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index; g.setAttribute('position', base.attributes.position);
  const A = (k) => new Float32Array(n * k);
  const at3 = { iCenter: A(3), iU: A(3), iV: A(3), iCB: A(3), iCA: A(3), iCK: A(3) }, at4 = { iA: A(4), iB: A(4), iD: A(4) };
  gals.forEach((o, i) => {
    const U = V3(1, 0, 0).applyQuaternion(o.q).multiplyScalar(o.R), W = V3(0, 0, 1).applyQuaternion(o.q).multiplyScalar(o.R);
    at3.iCenter.set(o.pos.toArray(), i * 3); at3.iU.set(U.toArray(), i * 3); at3.iV.set(W.toArray(), i * 3);
    at3.iCB.set(o.cB.toArray(), i * 3); at3.iCA.set(o.cA.toArray(), i * 3); at3.iCK.set(o.cK.toArray(), i * 3);
    at4.iA.set([o.arms, Math.tan(o.pitch), o.armAmp, o.laneS], i * 4);
    at4.iB.set([o.h, o.bulge, o.spin, o.seed * 1.37 % 20], i * 4);
    at4.iD.set([o.ringR || 0, o.ringS || 0, o.bar || 0, o.diskGain], i * 4);
  });
  for (const [k, v] of Object.entries(at3)) g.setAttribute(k, new THREE.InstancedBufferAttribute(v, 3));
  for (const [k, v] of Object.entries(at4)) g.setAttribute(k, new THREE.InstancedBufferAttribute(v, 4));
  g.instanceCount = n;
  const mat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 } }, vertexShader: diskVert, fragmentShader: diskFrag, transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false; mesh.renderOrder = -4.5;
  return { mesh, mat };
}

// ======================================================================================================
// Soft sprites: nebula puffs, filaments and glows, one instanced draw call. Billboards, or world-space quads
// (galaxy disk light) when iU/iV are given. They fade and collapse as the camera gets close.
// ======================================================================================================
const spriteVert = /* glsl */ `
attribute vec3 iCenter; attribute vec3 iU; attribute vec3 iV;
attribute vec4 iColor; // rgb, w billboard radius (0 = world quad)
attribute vec4 iParam; // x type (0 cloud, 1 glow, 2 filament, 3 disk), y seed, z drift, w roll
uniform float uTime;
varying vec2 vQ; varying vec3 vCol; varying vec4 vPar; varying float vFade;
${CF}
void main(){
  vec3 c=iCenter+iParam.z*vec3(sin(uTime*0.021+iParam.y*1.7),0.6*sin(uTime*0.017+iParam.y*2.3),cos(uTime*0.019+iParam.y*3.1));
  vec3 wc=(modelMatrix*vec4(c,1.0)).xyz;
  vec3 right=vec3(viewMatrix[0][0],viewMatrix[1][0],viewMatrix[2][0]);
  vec3 up=vec3(viewMatrix[0][1],viewMatrix[1][1],viewMatrix[2][1]);
  vec2 q=position.xy;
  float a=iParam.w+uTime*0.003*(fract(iParam.y*7.3)-0.5);
  vec2 qr=mat2(cos(a),sin(a),-sin(a),cos(a))*q;
  float bill=step(0.001,iColor.w);
  vec3 off=bill>0.5 ? (right*qr.x+up*qr.y)*iColor.w : iU*q.x+iV*q.y;
  float size=bill>0.5 ? iColor.w : max(length(iU),length(iV));
  float d=distance(cameraPosition,wc);
  float fade=smoothstep(size*0.7+2.0,size*1.8+10.0,d)*centerFade(wc);
  vQ=q; vCol=iColor.rgb*fade; vPar=iParam; vFade=fade;
  gl_Position=projectionMatrix*viewMatrix*vec4(wc+off,1.0);
  if(fade<0.002) gl_Position=vec4(2.0,2.0,2.0,1.0);
}`;
const spriteFrag = /* glsl */ `
uniform float uTime;
varying vec2 vQ; varying vec3 vCol; varying vec4 vPar; varying float vFade;
${NOISE}
void main(){
  float r2=dot(vQ,vQ); if(r2>1.0) discard;
  float type=vPar.x, seed=vPar.y;
  float t=uTime*0.012;
  float v;
  if(type<0.5){
    // nebula puff: domain-warped noise eroded into a lumpy body, sharp ionisation ridges, fine wisps
    float f=1.0-r2; f*=f;
    float n=snoise(vec3(vQ*1.2+seed*7.1,seed*3.3+t));
    float m=snoise(vec3(vQ*2.7+n*0.9+seed*2.3,seed+t*1.3));
    float k=snoise(vec3(vQ*6.5+m*0.7,seed*1.7-t));
    float dens=smoothstep(0.0,0.95,0.42+0.5*n+0.3*m-0.95*r2);
    float ridge=pow(1.0-abs(m),7.0)*smoothstep(0.05,0.5,dens+0.25*n);
    float wisp=pow(1.0-abs(k),5.0)*smoothstep(0.1,0.6,dens);
    v=f*(dens*dens*0.9+ridge*0.9+wisp*0.35)*(0.8+0.3*k)*2.6;
  } else if(type<1.5){
    // glow: halo + core
    v=exp(-r2*5.5)*(1.0-r2)+exp(-r2*40.0)*seed;
  } else if(type<2.5){
    // filament along local x: wandering ribbon with striations
    float x=vQ.x, y=vQ.y;
    float w=snoise(vec3(x*1.7+seed*5.0,seed,t*0.7));
    float yy=(y-0.35*w)*2.6;
    float prof=exp(-yy*yy*3.0);
    float str=0.65+0.35*snoise(vec3(x*7.0+seed,yy*1.5,t));
    v=prof*str*(1.0-x*x)*(1.0-x*x)*(0.6+0.4*snoise(vec3(x*3.1-seed,2.0,t)));
  } else if(type>4.5){
    // tiny background galaxy (world quad in its disk plane): bulge + exponential disk
    float r=sqrt(r2);
    v=exp(-r2*60.0)*1.2+exp(-r*5.0)*0.45*(1.0-r2);
  } else if(type>3.5){
    // ring nebula: a clumpy shell, teal inside and amber at the rim, with faint outer halo
    vec2 e=vQ*vec2(1.0,1.22); float r=length(e);
    float n=snoise(vec3(e*3.0,seed+t));
    float m=snoise(vec3(e*8.0+n,seed*2.0-t));
    float shell=exp(-pow((r-0.5-0.05*n)/0.075,2.0))*max(0.15,0.55+0.6*m+0.3*n);
    float inner=smoothstep(0.52,0.1,r)*0.22*(0.7+0.5*n);
    float halo=exp(-pow((r-0.75)/0.12,2.0))*0.25*(0.6+0.6*n);
    vec3 cc=vec3(0.2,0.75,0.8)*inner+mix(vec3(0.3,0.8,0.85),vec3(1.0,0.55,0.25),smoothstep(0.42,0.6,r))*shell+vec3(0.9,0.4,0.35)*halo;
    gl_FragColor=vec4(vCol*cc*(1.0-r2)*2.0,0.0);
    return;
  } else {
    // dark dust globule: absorbs what is behind it (premultiplied alpha), thin glowing rim where it thins out
    float f=1.0-r2; f*=f;
    float n=snoise(vec3(vQ*1.4+seed*7.1,seed*3.3+t));
    float m=snoise(vec3(vQ*3.3+n*0.8+seed*2.3,seed+t*1.4));
    float dens=smoothstep(0.0,0.8,0.45*n+0.12*m+0.9*(1.0-r2)-0.4)*f;
    float rim=smoothstep(0.02,0.2,dens)*(1.0-smoothstep(0.2,0.55,dens))*(0.6+0.4*m);
    gl_FragColor=vec4(vCol*rim,dens*0.95*vFade);
    return;
  }
  gl_FragColor=vec4(vCol*v,0.0);
}`;

function createSprites() {
  const list = [];
  const add = (center, color, radius, type, seed, drift = 0, roll = 0, U = null, Vv = null) => list.push({ center, color, radius, type, seed, drift, roll, U, V: Vv });
  return {
    list, add,
    build() {
      const n = list.length, base = new THREE.PlaneGeometry(2, 2);
      const g = new THREE.InstancedBufferGeometry();
      g.index = base.index; g.setAttribute('position', base.attributes.position);
      const c = new Float32Array(n * 3), u = new Float32Array(n * 3), v = new Float32Array(n * 3), cl = new Float32Array(n * 4), pr = new Float32Array(n * 4);
      list.forEach((s, i) => {
        c.set([s.center.x, s.center.y, s.center.z], i * 3);
        if (s.U) { u.set([s.U.x, s.U.y, s.U.z], i * 3); v.set([s.V.x, s.V.y, s.V.z], i * 3); }
        cl.set([s.color.r, s.color.g, s.color.b, s.U ? 0 : s.radius], i * 4);
        pr.set([s.type, s.seed, s.drift, s.roll], i * 4);
      });
      g.setAttribute('iCenter', new THREE.InstancedBufferAttribute(c, 3));
      g.setAttribute('iU', new THREE.InstancedBufferAttribute(u, 3));
      g.setAttribute('iV', new THREE.InstancedBufferAttribute(v, 3));
      g.setAttribute('iColor', new THREE.InstancedBufferAttribute(cl, 4));
      g.setAttribute('iParam', new THREE.InstancedBufferAttribute(pr, 4));
      g.instanceCount = n;
      const mat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 } }, vertexShader: spriteVert, fragmentShader: spriteFrag, transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
      const mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false; mesh.renderOrder = -6;
      return { mesh, mat, count: n };
    },
  };
}

// a nebula complex: clumps of puffs inside an ellipsoid, a palette blend across it, and a few filaments
function cloudComplex(S, o) {
  const r = rng(o.seed);
  const axis = (o.axis || randDir(r)).clone().normalize();
  const side = V3().crossVectors(axis, V3(0.3, 1, 0.2)).normalize(), up = V3().crossVectors(side, axis);
  const subs = [];
  for (let i = 0; i < o.clumps; i++) {
    const u = (i / Math.max(1, o.clumps - 1)) * 2 - 1;
    subs.push(o.center.clone().addScaledVector(axis, u * o.size * o.stretch * (0.85 + r() * 0.3)).addScaledVector(side, gauss(r) * o.size * 0.35).addScaledVector(up, gauss(r) * o.size * 0.3));
  }
  const tmp = new THREE.Color();
  for (let i = 0; i < o.puffs; i++) {
    const k = Math.floor(r() * subs.length);
    const p = subs[k].clone().add(randDir(r).multiplyScalar(o.size * 0.45 * Math.pow(r(), 0.6)));
    const s = Math.min(1, Math.max(0, (k / Math.max(1, subs.length - 1)) + gauss(r) * 0.15));
    const pal = o.palette; const f = s * (pal.length - 1), j = Math.min(pal.length - 2, Math.floor(f));
    tmp.copy(pal[j]).lerp(pal[j + 1], f - j).multiplyScalar(o.gain * (0.55 + r() * 0.6));
    const rr = o.rad || [0.3, 0.35];
    S.add(p, tmp.clone(), o.size * (rr[0] + r() * rr[1]), o.type || 0, r() * 10, o.size * 0.04, r() * 6.28);
  }
  if (o.nursery) for (const c of subs) o.nursery.push({ c, R: o.size * 0.35, n: 14 + Math.floor(r() * 16) });
  for (let i = 0; i < (o.filaments || 0); i++) {
    const a = subs[Math.floor(r() * subs.length)];
    const p = a.clone().add(randDir(r).multiplyScalar(o.size * 0.5));
    const dir = axis.clone().add(randDir(r).multiplyScalar(0.9)).normalize();
    const n2 = V3().crossVectors(dir, randDir(r)).normalize();
    const len = o.size * (0.6 + r() * 0.7);
    tmp.copy(o.palette[Math.floor(r() * o.palette.length)]).multiplyScalar(o.gain * 1.1);
    S.add(p, tmp.clone(), 0, 2, r() * 10, o.size * 0.03, 0, dir.multiplyScalar(len), n2.multiplyScalar(len * 0.22));
  }
}

// ======================================================================================================
// Point stars: mid-ground field stars (parallax), globular and open clusters, debris-stream dust.
// ======================================================================================================
const starVert = /* glsl */ `
attribute vec4 aData; // x size px (kind 2: world size), y brightness, z phase, w kind (0 field, 1 cluster, 2 belt dust)
attribute vec3 aColor;
uniform float uTime, uPx, uPixH, uBeltRate; uniform mat3 uBelt;
varying vec3 vCol; varying float vSoft;
${CF}
void main(){
  vec3 p=position;
  if(aData.w>1.5){ float a=p.y+uTime*uBeltRate; p=uBelt*vec3(p.x*cos(a),p.z,p.x*sin(a)); }
  vec4 mv=viewMatrix*modelMatrix*vec4(p,1.0);
  float d=-mv.z;
  float b, ps;
  if(aData.w>1.5){
    float px=aData.x*uPixH/max(d,0.1); ps=max(px,1.2);
    b=aData.y*min(1.0,px*px/(ps*ps))*smoothstep(3.0,14.0,d);
    vSoft=2.5;
  } else {
    ps=aData.x*uPx;
    float tw=0.8+0.2*sin(uTime*(0.7+aData.z*0.9)+aData.z*31.0)*sin(uTime*0.43+aData.z*13.0);
    b=aData.y*tw*clamp(14400.0/(d*d),0.25,2.2)*smoothstep(4.0,24.0,d);
    vSoft=7.5;
  }
  gl_PointSize=min(ps,32.0);
  b*=centerFade((modelMatrix*vec4(p,1.0)).xyz);
  vCol=aColor*b;
  gl_Position=projectionMatrix*mv;
  if(b<1e-4) gl_Position=vec4(2.0,2.0,2.0,1.0);
}`;
const starFrag = /* glsl */ `
varying vec3 vCol; varying float vSoft;
void main(){ vec2 c=gl_PointCoord*2.0-1.0; float r2=dot(c,c); if(r2>1.0) discard; gl_FragColor=vec4(vCol*(exp(-r2*vSoft)+0.04*(1.0-r2)),1.0); }`;

const TEMPS = ['#9db4ff', '#bccbff', '#e8ecff', '#fff4e6', '#ffe0b0', '#ffc38a', '#ff9d6a'].map(h => new THREE.Color(h));

// ======================================================================================================
// Debris stream: instanced faceted rocks lit by the sun at the origin.
// ======================================================================================================
const rockVert = /* glsl */ `
attribute vec4 iOrb;  // radius, angle, height, size
attribute vec4 iSpin; // axis xyz, rate
attribute vec3 iShape;
uniform float uTime, uBeltRate, uPixH; uniform mat3 uBelt;
varying vec3 vW; varying float vFade; varying float vAlb;
${CF}
void main(){
  float a=iOrb.y+uTime*uBeltRate;
  vec3 c=uBelt*vec3(iOrb.x*cos(a),iOrb.z,iOrb.x*sin(a));
  vec3 lp=position*iShape*iOrb.w;
  float ang=uTime*iSpin.w+iOrb.y*20.0;
  vec3 k=normalize(iSpin.xyz);
  lp=lp*cos(ang)+cross(k,lp)*sin(ang)+k*dot(k,lp)*(1.0-cos(ang));
  vec3 w=(modelMatrix*vec4(c+lp,1.0)).xyz;
  vW=w;
  float d=distance(cameraPosition,w);
  vFade=smoothstep(2.0,8.0,d)*smoothstep(0.5,1.4,iOrb.w*uPixH/d)*centerFade(w);
  vAlb=fract(iSpin.w*37.0);
  gl_Position=projectionMatrix*viewMatrix*vec4(w,1.0);
  if(vFade<0.002) gl_Position=vec4(2.0,2.0,2.0,1.0);
}`;
const rockFrag = /* glsl */ `
varying vec3 vW; varying float vFade; varying float vAlb;
void main(){
  vec3 N=normalize(cross(dFdx(vW),dFdy(vW)));
  vec3 V=normalize(cameraPosition-vW); if(dot(N,V)<0.0) N=-N;
  vec3 Ls=normalize(-vW);
  float diff=max(dot(N,Ls),0.0);
  float rim=pow(1.0-max(dot(N,V),0.0),3.0)*0.25*diff;
  if(fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(0.06711056,0.00583715))))>vFade) discard; // dithered fade (opaque)
  vec3 alb=mix(vec3(0.08,0.075,0.07),vec3(0.12,0.11,0.1),vAlb);
  float srim=pow(1.0-max(dot(N,V),0.0),2.0)*pow(diff,0.6);
  vec3 c=alb*vec3(1.0,0.88,0.72)*diff*0.3+vec3(1.0,0.66,0.36)*srim*0.16+vec3(0.003,0.004,0.008);
  gl_FragColor=vec4(c,1.0);
}`;

function rockGeometry(seed) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position, r = rng(seed);
  const k = [r() * 6, r() * 6, r() * 6, r() * 6];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const f = 1 + 0.22 * Math.sin(2.9 * x + k[0]) * Math.sin(3.1 * y + k[1]) + 0.16 * Math.sin(4.7 * z + k[2] + 2 * x) + 0.08 * Math.sin(7.3 * y + k[3] - 3 * z);
    p.setXYZ(i, x * f, y * f, z * f);
  }
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  return g;
}

// ======================================================================================================
// Comets: coma + straight blue ion tail + curved, fanned dust tail, both pointing away from the sun.
// ======================================================================================================
const cometVert = /* glsl */ `
attribute vec4 aC; // x comet, y kind (0 coma, 1 ion, 2 dust), z u, w s
uniform vec3 uHead[2]; uniform vec3 uVel[2]; uniform float uLen[2]; uniform float uBright[2];
varying vec2 vUS; varying float vKind; varying float vB; varying float vIdx;
${CF}
void main(){
  int i=int(aC.x+0.5);
  vec3 h=uHead[i]; vec3 v=normalize(uVel[i]); vec3 anti=normalize(h); float L=uLen[i];
  float u=aC.z, s=aC.w;
  vec3 p, T; float w;
  vec3 toCam=normalize(cameraPosition-h);
  if(aC.y<0.5){
    vec3 right=vec3(viewMatrix[0][0],viewMatrix[1][0],viewMatrix[2][0]);
    vec3 up=vec3(viewMatrix[0][1],viewMatrix[1][1],viewMatrix[2][1]);
    float R=L*0.11;
    p=h+right*u*R+up*s*R;
  } else {
    if(aC.y<1.5){
      p=h+anti*u*L*1.3; T=anti; w=L*(0.005+0.04*u);
    } else {
      vec3 vt=normalize(v-anti*dot(v,anti));
      p=h+(anti*u-vt*u*u*0.6)*L*0.85; T=normalize(anti-vt*2.0*u*0.6); w=L*(0.012+0.2*u);
    }
    vec3 sd=normalize(cross(T,normalize(cameraPosition-p)));
    p+=sd*s*w;
  }
  float d=distance(cameraPosition,h);
  vB=uBright[i]*smoothstep(5.0,30.0,d)*centerFade(h);
  // a head-on comet (tail foreshortened) would read as a lone bright star: dim the coma then
  float fs=length(cross(anti,normalize(h-cameraPosition)));
  if(aC.y<0.5) vB*=mix(0.12,1.0,smoothstep(0.3,0.8,fs));
  vUS=vec2(u,s); vKind=aC.y; vIdx=aC.x;
  gl_Position=projectionMatrix*viewMatrix*vec4(p,1.0);
}`;
const cometFrag = /* glsl */ `
uniform float uTime;
varying vec2 vUS; varying float vKind; varying float vB; varying float vIdx;
${NOISE}
void main(){
  float u=vUS.x, s=vUS.y; vec3 c;
  if(vKind<0.5){
    float r2=u*u+s*s; if(r2>1.0) discard;
    c=vec3(0.45,0.85,0.8)*exp(-r2*7.0)*0.4+vec3(0.8,0.95,1.0)*exp(-r2*60.0)*0.6+vec3(1.0)*exp(-r2*500.0)*1.0;
  } else if(vKind<1.5){
    float prof=exp(-s*s*5.0);
    float str=0.55+0.45*snoise(vec3(u*7.0-uTime*0.35,s*3.5,vIdx*7.0));
    float kink=0.7+0.3*snoise(vec3(u*2.5-uTime*0.2,vIdx*3.0,1.0));
    float fall=pow(1.0-u,1.4)*smoothstep(0.0,0.04,u);
    c=vec3(0.3,0.56,1.0)*prof*str*kink*fall*1.0;
  } else {
    float prof=exp(-(s-0.25)*(s-0.25)*2.6)*(1.0-s*s);
    float fall=pow(1.0-u,1.8)*smoothstep(0.0,0.05,u);
    float striae=0.82+0.18*sin(u*38.0+s*4.0+vIdx*3.0);
    c=vec3(1.0,0.84,0.62)*prof*fall*striae*0.7;
  }
  gl_FragColor=vec4(c*vB,1.0);
}`;

function cometGeometry() {
  const SEG = 48, pos = [], aC = [], idx = [];
  let base = 0;
  for (let ci = 0; ci < 2; ci++) {
    // coma quad
    for (const [u, s] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { pos.push(0, 0, 0); aC.push(ci, 0, u, s); }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3); base += 4;
    for (const kind of [2, 1]) {
      for (let j = 0; j <= SEG; j++) for (const s of [-1, 1]) { pos.push(0, 0, 0); aC.push(ci, kind, j / SEG, s); }
      for (let j = 0; j < SEG; j++) { const a = base + j * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
      base += (SEG + 1) * 2;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aC', new THREE.Float32BufferAttribute(aC, 4));
  g.setIndex(idx);
  return g;
}

// Keplerian orbit around the origin (sun), with GM folded into the mean motion
function makeOrbit({ q, Q, normal, peri, n, M0 }) {
  const a = (q + Q) / 2, e = (Q - q) / (Q + q), b = a * Math.sqrt(1 - e * e);
  const N = normal.clone().normalize(), X = peri.clone().projectOnPlane(N).normalize(), Y = V3().crossVectors(N, X);
  return (t, outP, outV) => {
    const M = M0 + n * t; let E = M;
    for (let k = 0; k < 8; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const x = a * (Math.cos(E) - e), y = b * Math.sin(E);
    outP.copy(X).multiplyScalar(x).addScaledVector(Y, y);
    outV.copy(X).multiplyScalar(-a * Math.sin(E)).addScaledVector(Y, b * Math.cos(E));
  };
}

// ======================================================================================================
// Meteors: rare, short streaks far out, scheduled by hashing the time slot.
// ======================================================================================================
const meteorVert = /* glsl */ `
attribute vec3 aM; // slot, u, s
uniform float uTime;
varying float vA; varying float vS;
${CF}
float h1(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }
void main(){
  float slot=aM.x, u=aM.y, s=aM.z;
  float P=11.0+slot*4.3;
  float x=uTime/P+slot*0.37; float cyc=floor(x), ph=fract(x);
  float k=cyc*13.17+slot*71.3;
  float on=step(h1(k),0.55);
  float st=0.1+0.6*h1(k+1.0), dur=1.3/P;
  float life=(ph-st)/dur;
  float alive=on*step(0.0,life)*step(life,1.0);
  float z=h1(k+2.0)*0.75-0.55, az=h1(k+3.0)*6.2832, sz=sqrt(1.0-z*z);
  vec3 dir=vec3(cos(az)*sz,z,sin(az)*sz);
  vec3 c=dir*(150.0+120.0*h1(k+4.0));
  vec3 t1=normalize(cross(dir,vec3(0.0,1.0,0.0)+0.001)); vec3 t2=cross(dir,t1);
  float ta=h1(k+5.0)*6.2832; vec3 vel=normalize(t1*cos(ta)+t2*sin(ta)-vec3(0.0,0.25,0.0));
  float travel=34.0+20.0*h1(k+6.0), len=14.0+10.0*h1(k+7.0);
  vec3 head=c+vel*travel*(life-0.5);
  vec3 p=head-vel*len*u*min(1.0,life*3.0);
  float d=distance(cameraPosition,p);
  vec3 sd=normalize(cross(vel,normalize(cameraPosition-p)));
  p+=sd*s*d*0.0016*(1.0-u*0.7);
  vA=alive*sin(3.14159*clamp(life,0.0,1.0))*pow(1.0-u,1.6)*(0.6+0.4*h1(k+8.0))*centerFade(head);
  vS=s;
  gl_Position=projectionMatrix*viewMatrix*vec4(p,1.0);
  if(alive<0.5) gl_Position=vec4(2.0,2.0,2.0,1.0);
}`;
const meteorFrag = /* glsl */ `
varying float vA; varying float vS;
void main(){ float p=exp(-vS*vS*3.0); gl_FragColor=vec4(vec3(0.85,0.92,1.0)*vA*p*0.9,1.0); }`;

// ======================================================================================================
// Ringed planet: banded gas giant lit by the sun at the origin; ring with Cassini gap; mutual shadows.
// ======================================================================================================
const planetVert = /* glsl */ `
uniform vec3 uC;
varying vec3 vN; varying vec3 vW; varying vec3 vL; varying float vCF;
${CF}
void main(){ vCF=centerFadeK(uC,1.35); vL=normalize(position); vN=normalize(mat3(modelMatrix)*normal); vec4 w=modelMatrix*vec4(position,1.0); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`;
const planetFrag = /* glsl */ `
uniform vec3 uC; uniform vec3 uRingN; uniform float uR, uTime;
varying vec3 vN; varying vec3 vW; varying vec3 vL; varying float vCF;
${NOISE}
float rh(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }
float rn(float x){ float i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f); return mix(rh(i),rh(i+1.0),f); }
float ringDen(float rr){
  float C=0.22*smoothstep(1.24,1.3,rr)*(1.0-smoothstep(1.5,1.53,rr));
  float B=smoothstep(1.5,1.56,rr)*(1.0-smoothstep(1.92,1.95,rr))*(0.75+0.25*smoothstep(1.55,1.8,rr));
  float A=0.62*smoothstep(1.99,2.03,rr)*(1.0-smoothstep(2.26,2.3,rr))*(1.0-0.9*exp(-pow((rr-2.2)/0.008,2.0)));
  float d=C+B+A;
  d*=0.62+0.38*(rn(rr*90.0)*0.6+rn(rr*310.0)*0.4);
  return clamp(d,0.0,1.0);
}
void main(){
  vec3 N=normalize(vN); vec3 Ls=normalize(-uC); vec3 V=normalize(cameraPosition-vW);
  float lat=vL.y;
  float w=snoise(vec3(vL.xz*2.0,lat*3.0+uTime*0.004))*0.022;
  float bands=sin((lat+w)*22.0+0.4*sin(lat*9.0))*0.5+0.5; float bands2=sin((lat+w*1.6)*57.0+1.0)*0.5+0.5;
  vec3 a=mix(vec3(0.82,0.68,0.5),vec3(0.92,0.84,0.68),bands*0.7); a=mix(a,vec3(0.7,0.56,0.42),bands2*0.18);
  a=mix(a,vec3(0.55,0.68,0.78),smoothstep(0.7,0.95,abs(lat))*0.6);
  float diff=max(dot(N,Ls),0.0);
  float term=smoothstep(-0.05,0.25,dot(N,Ls));
  // ring shadow on the planet
  float tt=dot(uC-vW,uRingN)/dot(Ls,uRingN);
  float sh=1.0;
  if(tt>0.0){ vec3 hp=vW+Ls*tt; sh=1.0-0.75*ringDen(length(hp-uC)/uR); }
  float mu=max(dot(N,V),0.0);
  vec3 c=a*(pow(diff,0.8)*0.38*sh)*mix(0.75,1.0,mu);
  c+=vec3(0.35,0.55,0.8)*pow(1.0-mu,3.0)*term*0.12;
  // warm hazy limb on the day side and a thin forward-scattering rim around the night side
  c+=vec3(1.0,0.72,0.42)*pow(1.0-mu,2.2)*smoothstep(-0.2,0.5,dot(N,Ls))*0.16;
  c+=vec3(0.9,0.6,0.35)*pow(1.0-mu,6.0)*pow(max(dot(-V,Ls),0.0),3.0)*0.25;
  gl_FragColor=vec4(c*vCF,1.0);
}`;
const ringVert = /* glsl */ `
uniform vec3 uC;
varying vec3 vW; varying float vCF;
${CF}
void main(){ vCF=centerFadeK(uC,1.35); vec4 w=modelMatrix*vec4(position,1.0); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`;
const ringFrag = /* glsl */ `
uniform vec3 uC; uniform vec3 uRingN; uniform float uR;
varying vec3 vW; varying float vCF;
float rh(float p){ p=fract(p*0.1031); p*=p+33.33; p*=p+p; return fract(p); }
float rn(float x){ float i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f); return mix(rh(i),rh(i+1.0),f); }
float ringDen(float rr){
  float C=0.22*smoothstep(1.24,1.3,rr)*(1.0-smoothstep(1.5,1.53,rr));
  float B=smoothstep(1.5,1.56,rr)*(1.0-smoothstep(1.92,1.95,rr))*(0.75+0.25*smoothstep(1.55,1.8,rr));
  float A=0.62*smoothstep(1.99,2.03,rr)*(1.0-smoothstep(2.26,2.3,rr))*(1.0-0.9*exp(-pow((rr-2.2)/0.008,2.0)));
  float d=C+B+A;
  d*=0.62+0.38*(rn(rr*90.0)*0.6+rn(rr*310.0)*0.4);
  return clamp(d,0.0,1.0);
}
void main(){
  vec3 dv=vW-uC; float rr=length(dv)/uR;
  float den=ringDen(rr); if(den<0.003) discard;
  vec3 Ls=normalize(-uC); vec3 V=normalize(cameraPosition-vW);
  // planet shadow
  float tc=dot(-dv,Ls); float sh=1.0;
  if(tc>0.0){ float miss=length(dv+Ls*tc)/uR; sh=smoothstep(0.96,1.04,miss); }
  float sameSide=sign(dot(Ls,uRingN))*sign(dot(V,uRingN));
  float lit=sameSide>0.0 ? 0.4 : 0.12;
  vec3 c=mix(vec3(0.66,0.56,0.45),vec3(0.88,0.82,0.72),rn(rr*25.0))*den*lit*sh;
  float d=distance(cameraPosition,vW);
  gl_FragColor=vec4(c*smoothstep(4.0,16.0,d)*vCF,1.0);
}`;

// ======================================================================================================
export function createAmbient({ nodes = [] } = {}) {
  const group = new THREE.Group();
  group.name = 'ambient';
  const mats = [];
  let points = 0;

  // keep-out test used for any scattered thing near the graph
  const clearOf = (p, pad = 0) => {
    if (p.length() < 52 + pad) return false;
    for (const n of nodes) if (p.distanceTo(n.position) < n.clear + 12 + pad) return false;
    return true;
  };

  // ----- galaxies -----
  const GD = [
    { ...L.g1, arms: 2, pitch: 0.36, bulge: 0.12, h: 0.4, armAmp: 0.88, armSharp: 3, lane: 0.85, laneOff: 0.75, thick: 0.018, laneS: 0.9,
      nStars: 7000, nDiffuse: 0, nKnots: 60, nBulge: 1600, bulgeFlat: 0.7, cBulge: '#ffd29a', cInner: '#ffe6c4', cArm: '#9fbaff', cKnot: '#ff5f9a', gain: 0.36, spin: 0.004,
      cB: col('#ffcf96', 0.5), cA: col('#a4c0ff', 0.9), cK: col('#ff4f8f', 0.6), diskGain: 0.8 },
    { ...L.g2, arms: 2, pitch: 0.25, bulge: 0.24, h: 0.27, armAmp: 0.2, armSharp: 2, lane: 0, laneOff: 0.7, thick: 0.03, midLane: 0.016, laneS: 0,
      nStars: 4500, nDiffuse: 0, nKnots: 6, nBulge: 2200, bulgeFlat: 0.62, cBulge: '#ffc98e', cInner: '#ffe2bf', cArm: '#dfe4ff', cKnot: '#ff8fb0', gain: 0.42, spin: 0.003,
      cB: col('#ffc88c', 0.5), cA: col('#e8dccc', 0.32), cK: col('#ff8fb0', 0.1), ringR: 0.58, ringS: 1.0, diskGain: 1 },
    { ...L.g3, arms: 2, pitch: 0.42, bulge: 0.09, h: 0.42, armAmp: 0.8, armSharp: 2.5, lane: 0.6, laneOff: 0.7, thick: 0.02, bar: 0.22, laneS: 0.6,
      nStars: 4000, nDiffuse: 0, nKnots: 30, nBulge: 700, bulgeFlat: 0.7, cBulge: '#fff0d6', cInner: '#f2efff', cArm: '#7fb6ff', cKnot: '#ff6fa8', gain: 0.42, spin: 0.005,
      cB: col('#ffeacc', 0.4), cA: col('#86b2ff', 0.9), cK: col('#ff5fa0', 0.45), diskGain: 1 },
    { ...L.g4, arms: 3, pitch: 0.5, bulge: 0.08, h: 0.38, armAmp: 0.6, armSharp: 2, lane: 0.4, laneOff: 0.7, thick: 0.02, laneS: 0.45,
      nStars: 3500, nDiffuse: 0, nKnots: 30, nBulge: 500, bulgeFlat: 0.7, cBulge: '#ffe2c0', cInner: '#f0ecff', cArm: '#a0c4ff', cKnot: '#ff7ab0', gain: 0.38, spin: 0.004,
      cB: col('#ffe0b8', 0.35), cA: col('#9cc0ff', 0.75), cK: col('#ff6aa8', 0.5), diskGain: 0.9 },
  ];
  for (const o of GD) { const g = makeGalaxy(o); o.q = g.pts.quaternion; group.add(g.pts); mats.push(g.mat); points += g.count; }
  const disks = createDisks(GD); group.add(disks.mesh); mats.push(disks.mat);

  // ----- sprites: nebulae, filaments, glows -----
  const S = createSprites();
  const teal = col('#1aa7b8'), rose = col('#c04a86'), amber = col('#e08a3a'), violet = col('#6a3cd6'), blue = col('#3a6be0'), pink = col('#ff6fae');
  // soft halo around each galaxy
  for (const o of GD) S.add(o.pos.clone(), col(o.cBulge, o.ringS ? 0.07 : 0.03), o.R * (o.ringS ? 0.42 : 0.55), 1, 0.3, 0, 0);
  // nebula complexes at different depths and heights (teal/rose/amber/violet); some host young star clusters
  const nursery = [];
  cloudComplex(S, { nursery, seed: 3, center: at(2.75, 135, 18), size: 26, stretch: 1.3, clumps: 4, puffs: 22, filaments: 4, palette: [teal, col('#3fd6c4'), blue], gain: 0.07, axis: V3(0.4, 0.5, -0.7) });
  S.add(at(5.75, 160, -62), col('#c04a86', 0.02), 30 * 1.3, 1, 0, 0, 0);
  cloudComplex(S, { nursery, seed: 5, center: at(5.75, 160, -62), size: 30, stretch: 1.2, clumps: 5, puffs: 40, rad: [0.2, 0.25], filaments: 5, palette: [rose, pink, amber], gain: 0.032, axis: V3(1, -0.3, 0.2) });
  cloudComplex(S, { seed: 7, center: at(1.2, 230, -95), size: 45, stretch: 1.0, clumps: 4, puffs: 18, filaments: 3, palette: [violet, rose, violet], gain: 0.035 });
  cloudComplex(S, { seed: 9, center: at(4.1, 120, 70), size: 22, stretch: 1.6, clumps: 3, puffs: 14, filaments: 4, palette: [amber, rose], gain: 0.04, axis: V3(0.2, 0.3, 1) });
  cloudComplex(S, { seed: 13, center: at(3.4, 200, -60), size: 34, stretch: 1.1, clumps: 3, puffs: 14, filaments: 3, palette: [teal, violet], gain: 0.035 });
  cloudComplex(S, { seed: 15, center: V3(-115, -175, 80), size: 40, stretch: 1.2, clumps: 4, puffs: 16, filaments: 4, palette: [blue, teal, violet], gain: 0.035 });
  cloudComplex(S, { seed: 17, center: V3(150, -60, -120), size: 40, stretch: 1.2, clumps: 4, puffs: 16, filaments: 4, palette: [rose, violet, teal], gain: 0.035 });
  // the richest emission complex, low on the far side of the default view, with a dark globule in front
  cloudComplex(S, { nursery, seed: 41, center: at(4.45, 195, -108), size: 34, stretch: 1.4, clumps: 5, puffs: 26, filaments: 6, palette: [teal, blue, rose, pink], gain: 0.06, axis: V3(0.9, 0.35, -0.3) });
  cloudComplex(S, { seed: 43, type: 3, center: at(4.38, 175, -96), size: 12, stretch: 1.6, clumps: 2, puffs: 5, palette: [amber, rose], gain: 0.06, axis: V3(1, 0.5, 0) });
  // a ring of emission complexes 15-40 degrees below the chart plane on every side: the sky is darkest down
  // there, so this is where faint gas reads best and fills the lower half of the overview frame
  const cyan = col('#3fd6c4');
  cloudComplex(S, { seed: 61, center: at(4.66, 143, -96), size: 32, stretch: 1.3, clumps: 4, puffs: 24, filaments: 4, palette: [teal, blue], gain: 0.07, axis: V3(1, 0.2, 0.3) });
  cloudComplex(S, { nursery, seed: 63, center: at(5.44, 118, -112), size: 30, stretch: 1.2, clumps: 4, puffs: 22, filaments: 4, palette: [amber, rose], gain: 0.07, axis: V3(0.3, 0.1, 1) });
  cloudComplex(S, { seed: 65, center: at(6.25, 147, -90), size: 34, stretch: 1.3, clumps: 4, puffs: 24, filaments: 5, palette: [teal, cyan, blue], gain: 0.065, axis: V3(1, -0.2, -0.2) });
  cloudComplex(S, { seed: 67, center: at(1.43, 135, -103), size: 30, stretch: 1.4, clumps: 4, puffs: 22, filaments: 4, palette: [rose, amber], gain: 0.07, axis: V3(0.2, 0.3, 1) });
  cloudComplex(S, { nursery, seed: 69, center: at(3.89, 99, -104), size: 38, stretch: 1.2, clumps: 5, puffs: 28, filaments: 5, palette: [blue, teal, cyan], gain: 0.08, axis: V3(1, 0, 0.5) });
  cloudComplex(S, { seed: 71, center: at(2.6, 160, -80), size: 30, stretch: 1.3, clumps: 4, puffs: 20, filaments: 4, palette: [amber, rose, violet], gain: 0.065, axis: V3(0.5, 0.2, -1) });
  // a large faint ring nebula (teal inner shell, amber outer rim) for the upper-right of the far side
  S.add(at(1.57, 192, 20), col('#ffffff', 0.06), 40, 4, 3.3, 0, 0.6);
  // tiny background galaxies scattered over the whole sphere (some straight up or down), a few pixels across
  {
    const r = rng(77);
    for (let i = 0; i < 16; i++) {
      let d; do { d = randDir(r); } while (Math.abs(d.y) < 0.2 && r() < 0.5);
      if (i < 2) d.set((r() - 0.5) * 0.3, i ? 1 : -1, (r() - 0.5) * 0.3).normalize();
      const p = d.multiplyScalar(280 + r() * 50), R = 1.0 + r() * 1.6;
      const nrm = randDir(r), U = V3().crossVectors(nrm, randDir(r)).normalize(), W = V3().crossVectors(nrm, U);
      S.add(p, col(r() < 0.6 ? '#ffe2c2' : '#dfe6ff', 0.32 + r() * 0.2), 0, 5, r() * 10, 0, 0, U.multiplyScalar(R), W.multiplyScalar(R));
    }
  }
  // near-field dust motes: very soft, dim, slightly warm, inside the overview orbit for parallax
  {
    const r = rng(83);
    let k = 0;
    while (k < 50) {
      const p = randDir(r).multiplyScalar(30 + r() * 25);
      if (Math.abs(p.y) < 14 || nodes.some(n => p.distanceTo(n.position) < n.clear + 12)) continue;
      S.add(p, col(r() < 0.5 ? '#ffd8b0' : '#cfd8ff', 0.02), 1.5 + r() * 1.5, 1, 0, 0.6, 0); k++;
    }
  }
  // cluster glows and the open cluster's reflection nebula
  S.add(L.glob1.pos.clone(), col('#ffd9a0', 0.12), L.glob1.R * 0.7, 1, 0.8, 0, 0);
  S.add(L.glob2.pos.clone(), col('#ffd9a0', 0.12), L.glob2.R * 0.7, 1, 0.8, 0, 0);
  cloudComplex(S, { seed: 21, center: L.open1.pos.clone(), size: 9, stretch: 0.8, clumps: 3, puffs: 8, filaments: 3, palette: [blue, col('#6f9cff')], gain: 0.05 });
  // dark dust globules silhouetted against the bright marbling, rim-lit
  cloudComplex(S, { seed: 31, type: 3, center: at(0.95, 240, 36), size: 42, stretch: 1.4, clumps: 3, puffs: 9, palette: [amber, rose], gain: 0.09, axis: V3(1, 0.25, 0) });
  cloudComplex(S, { seed: 33, type: 3, center: at(4.2, 250, 34), size: 42, stretch: 1.2, clumps: 3, puffs: 8, palette: [rose, amber], gain: 0.09, axis: V3(0.3, -0.2, 1) });
  cloudComplex(S, { seed: 35, type: 3, center: at(5.55, 230, 30), size: 42, stretch: 1.5, clumps: 3, puffs: 8, palette: [teal, amber], gain: 0.09, axis: V3(1, -0.4, 0.3) });
  cloudComplex(S, { seed: 39, type: 3, center: at(2.2, 210, 40), size: 40, stretch: 1.3, clumps: 2, puffs: 6, palette: [amber, rose], gain: 0.09 });
  // belt frame: local x toward the arc centre, local y the orbit normal (rolled about x), local z along the orbit
  const bX = V3(Math.cos(L.belt.elev) * Math.sin(L.belt.az), Math.sin(L.belt.elev), Math.cos(L.belt.elev) * Math.cos(L.belt.az));
  const bY0 = V3(0, 1, 0).addScaledVector(bX, -bX.y).normalize().applyAxisAngle(bX, L.belt.roll);
  const bZ = V3().crossVectors(bX, bY0).normalize();
  const beltM = new THREE.Matrix3().set(bX.x, bY0.x, bZ.x, bX.y, bY0.y, bZ.y, bX.z, bY0.z, bZ.z);
  // amber dust haze along the debris stream
  for (let i = 0; i < 11; i++) {
    const a = (i / 10 - 0.5) * L.belt.span * 0.9, rad = L.belt.R + (i % 2 ? 2 : -2);
    const p = V3(rad * Math.cos(a), (i % 3 - 1) * 1.2, rad * Math.sin(a)).applyMatrix3(beltM);
    const tng = V3(-Math.sin(a), 0, Math.cos(a)).applyMatrix3(beltM).multiplyScalar(L.belt.R * 0.13), nrm = V3(Math.cos(a), 0, Math.sin(a)).applyMatrix3(beltM).multiplyScalar(L.belt.width * 0.9);
    S.add(p, col(i % 2 ? '#c98a4a' : '#9a7a6a', 0.06), 0, 2, 50 + i * 3.1, 0, 0, tng, nrm);
  }
  const sprites = S.build();
  group.add(sprites.mesh); mats.push(sprites.mat);

  // ----- point stars -----
  {
    const r = rng(101), P = [], D = [], C = [];
    const push = (p, size, b, kind, c) => { P.push(p.x, p.y, p.z); D.push(size, b, r() * 10, kind); C.push(c.r, c.g, c.b); };
    // mid-ground field stars: a shell from 60 to 320, thicker toward the galactic band, outside the graph
    let n = 0;
    while (n < 4200) {
      const p = randDir(r).multiplyScalar(60 + Math.pow(r(), 0.8) * 260);
      if (!clearOf(p, 6)) continue;
      const m = Math.pow(r(), 5);
      const t = TEMPS[Math.min(6, Math.floor(Math.pow(r(), 0.9) * 7))];
      // about one in fifteen of the nearer stars is bright enough to slide visibly against the sky while orbiting
      if (p.length() < 120 && r() < 1 / 15) push(p, 2.4 + r() * 1.1, 0.3 + r() * 0.2, 0, t);
      else push(p, 1.4 + m * 2.6, 0.06 + m * 0.5, 0, t);
      n++;
    }
    // globular clusters: King-like cores, old yellow-orange giants
    for (const g of [L.glob1, L.glob2]) {
      for (let i = 0; i < 1300; i++) {
        const s = Math.pow(r(), 3.5) * 1.0 + 0.02;
        const p = randDir(r).multiplyScalar(g.R * s / (1.02 - Math.min(0.9, s) * 0.5)).add(g.pos);
        const giant = r() < 0.08;
        const t = giant ? TEMPS[5 + Math.floor(r() * 2)] : TEMPS[3 + Math.floor(r() * 2)];
        push(p, giant ? 2.2 : 1.3 + r() * 0.6, giant ? 0.3 : 0.12 + r() * 0.08, 1, t);
      }
    }
    // young stars embedded in the nebula complexes
    for (const nb of nursery) for (let i = 0; i < nb.n; i++) {
      const p = V3(gauss(r), gauss(r), gauss(r)).multiplyScalar(nb.R * 0.5).add(nb.c);
      const m = Math.pow(r(), 4);
      push(p, 1.4 + m * 2.4, 0.08 + m * 0.5, 1, TEMPS[Math.floor(r() * 3)]);
    }
    // open cluster: a few dozen young blue-white stars
    for (let i = 0; i < 90; i++) {
      const p = V3(gauss(r), gauss(r) * 0.7, gauss(r)).multiplyScalar(L.open1.R * 0.45).add(L.open1.pos);
      const m = Math.pow(r(), 3);
      push(p, 1.6 + m * 3.2, 0.12 + m * 0.75, 1, TEMPS[Math.floor(r() * 3)]);
    }
    // debris dust (belt-local polar coords: x radius, y angle, z height)
    for (let i = 0; i < 3500; i++) {
      const a = (r() - 0.5) * L.belt.span * (0.6 + 0.4 * r()) * 1.15;
      const edge = 1 - Math.pow(Math.abs(a) / (L.belt.span * 0.6), 2);
      const rad = L.belt.R + gauss(r) * L.belt.width * 0.8, h = gauss(r) * L.belt.thick;
      P.push(rad, a, h); D.push(0.1 + r() * 0.12, 0.05 * Math.max(0.1, edge) * (0.5 + r()), r(), 2);
      const c = col('#c9a27a').lerp(col('#8fa0c0'), r() * 0.5); C.push(c.r, c.g, c.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('aData', new THREE.Float32BufferAttribute(D, 4));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(C, 3));
    var starMat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uPx: { value: 1 }, uPixH: { value: 800 }, uBeltRate: { value: 0.0035 }, uBelt: { value: beltM } }, vertexShader: starVert, fragmentShader: starFrag, ...additive });
    const pts = new THREE.Points(g, starMat); pts.frustumCulled = false; pts.renderOrder = -4;
    group.add(pts); mats.push(starMat); points += P.length / 3;
  }

  // ----- debris rocks -----
  {
    const NR = 320, r = rng(202);
    const geo = new THREE.InstancedBufferGeometry().copy(rockGeometry(5));
    const orb = new Float32Array(NR * 4), spin = new Float32Array(NR * 4), shape = new Float32Array(NR * 3);
    for (let i = 0; i < NR; i++) {
      const a = (r() - 0.5) * L.belt.span * (0.5 + 0.5 * r());
      const size = 0.12 + Math.pow(r(), 3) * 0.9;
      orb.set([L.belt.R + gauss(r) * L.belt.width * 0.6, a, gauss(r) * L.belt.thick * 0.8, size], i * 4);
      const ax = randDir(r); spin.set([ax.x, ax.y, ax.z, (r() - 0.5) * 0.5], i * 4);
      shape.set([0.7 + r() * 0.6, 0.6 + r() * 0.5, 0.8 + r() * 0.5], i * 3);
    }
    geo.setAttribute('iOrb', new THREE.InstancedBufferAttribute(orb, 4));
    geo.setAttribute('iSpin', new THREE.InstancedBufferAttribute(spin, 4));
    geo.setAttribute('iShape', new THREE.InstancedBufferAttribute(shape, 3));
    geo.instanceCount = NR;
    var rockMat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uBeltRate: { value: 0.0035 }, uBelt: { value: beltM } }, vertexShader: rockVert, fragmentShader: rockFrag, depthWrite: true, depthTest: true });
    const mesh = new THREE.Mesh(geo, rockMat); mesh.frustumCulled = false; mesh.renderOrder = -3;
    group.add(mesh); mats.push(rockMat);
  }

  // ----- comets -----
  const orbits = [
    makeOrbit({ q: 78, Q: 340, normal: V3(-0.04, 0.6, -0.93), peri: at(4.72, 1, 0.3), n: 0.0011, M0: 0.02 }),
    makeOrbit({ q: 85, Q: 360, normal: V3(-0.3, 0.8, 0.5), peri: at(5.9, 1, -0.5), n: 0.0009, M0: -0.35 }),
  ];
  const cu = { uTime: { value: 0 }, uHead: { value: [V3(), V3()] }, uVel: { value: [V3(), V3()] }, uLen: { value: [10, 10] }, uBright: { value: [1, 1] } };
  const cometMat = new THREE.ShaderMaterial({ uniforms: cu, vertexShader: cometVert, fragmentShader: cometFrag, ...additive, side: THREE.DoubleSide });
  const comets = new THREE.Mesh(cometGeometry(), cometMat); comets.frustumCulled = false; comets.renderOrder = -2;
  group.add(comets); mats.push(cometMat);

  // ----- meteors -----
  {
    const SEG = 12, NS = 4, A = [], idx = [];
    for (let k = 0; k < NS; k++) {
      const b = A.length / 3;
      for (let j = 0; j <= SEG; j++) for (const s of [-1, 1]) A.push(k, j / SEG, s);
      for (let j = 0; j < SEG; j++) { const a = b + j * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(A.length), 3));
    g.setAttribute('aM', new THREE.Float32BufferAttribute(A, 3)); g.setIndex(idx);
    var meteorMat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 } }, vertexShader: meteorVert, fragmentShader: meteorFrag, ...additive, side: THREE.DoubleSide });
    const m = new THREE.Mesh(g, meteorMat); m.frustumCulled = false; m.renderOrder = -2;
    group.add(m); mats.push(meteorMat);
  }

  // ----- ringed planet -----
  {
    const pl = L.planet;
    const holder = new THREE.Group(); holder.position.copy(pl.pos); holder.rotation.set(...pl.tilt);
    holder.updateMatrixWorld();
    const ringN = V3(0, 1, 0).applyQuaternion(holder.quaternion);
    const pu = { uC: { value: pl.pos.clone() }, uRingN: { value: ringN }, uR: { value: pl.R }, uTime: { value: 0 } };
    var planetMat = new THREE.ShaderMaterial({ uniforms: pu, vertexShader: planetVert, fragmentShader: planetFrag, depthWrite: true, depthTest: true });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(pl.R, 64, 40), planetMat);
    sphere.renderOrder = -7;
    const ringMat = new THREE.ShaderMaterial({ uniforms: pu, vertexShader: ringVert, fragmentShader: ringFrag, ...additive, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(pl.R * 1.22, pl.R * 2.32, 160, 1), ringMat);
    ring.rotation.x = -Math.PI / 2; ring.renderOrder = -1;
    holder.add(sphere, ring); group.add(holder); mats.push(planetMat, ringMat);
  }

  const tmpP = V3(), tmpV = V3();
  for (const m of mats) { m.uniforms.uCF = { value: 1 }; m.uniforms.uCard = { value: 0 }; if (!m.uniforms.uPixH) m.uniforms.uPixH = { value: 800 }; }
  const info = { drawCalls: group.children.length + 1, points };
  group.userData.info = info; group.userData.layout = L; group.userData.cometHeads = cu.uHead.value;
  return {
    group, info,
    update(time, dt, camera, viewportHeightPx = 800) {
      const pixH = viewportHeightPx / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      // DEV ONLY: setting globalThis.__ambientNoCF in the console turns off the centre/card/title dimming, for
      // close-up screenshots of single decor objects. Never set by the site itself.
      const cf = globalThis.__ambientNoCF ? 0 : 1;
      let dn = 1e9; for (const n of nodes) dn = Math.min(dn, camera.position.distanceTo(n.position));
      const card = camera.aspect > 1.05 ? 1 - THREE.MathUtils.smoothstep(dn, 13, 20) : 0;
      for (const m of mats) { const u = m.uniforms; if (u.uTime) u.uTime.value = time; if (u.uPixH) u.uPixH.value = pixH; u.uCF.value = cf; u.uCard.value = card; }
      starMat.uniforms.uPx.value = Math.max(1, viewportHeightPx / 900);
      for (let i = 0; i < 2; i++) {
        orbits[i](time, tmpP, tmpV);
        cu.uHead.value[i].copy(tmpP); cu.uVel.value[i].copy(tmpV);
        const rr = tmpP.length();
        cu.uLen.value[i] = 40 * Math.pow(75 / rr, 1.1);
        cu.uBright.value[i] = Math.min(1, Math.pow(80 / rr, 1.5));
      }
    },
  };
}
