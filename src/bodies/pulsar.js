// Pulsar / magnetar: a tiny blue-white neutron star spinning with two volumetric lighthouse beams along a tilted
// magnetic axis, glowing dipole field lines with travelling energy pulses, trapped charged particles bouncing between
// mirror points, outflow particles streaming up the beams, and expanding equatorial pulse rings with spiral arms.
// create({ seed, period, tilt, intensity, beamLength, beamIntensity, fieldIntensity, ringIntensity, particles,
//          coreColor, beamColor, fieldColor, accentColor }) -> { group, radius, update(time, dt, camera) }
import * as THREE from 'three';
import { NOISE } from '../glsl.js';
import { unitSphere, SPHERE_LODS, projectedPx, lodIndex, noteViewH } from './star.js';

function rng(seed) {
  let a = (seed * 2654435761) >>> 0 || 1;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const CORE_R = 0.42;

// ---------------------------------------------------------------- core (opaque, in the magnetic frame)
const coreVert = /* glsl */ `
varying vec3 vObj; varying vec3 vN; varying vec3 vV;
void main(){ vObj=position; vec4 mv=modelViewMatrix*vec4(position,1.0); vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`;
const coreFrag = /* glsl */ `
uniform float uTime,uSeed,uIntensity; uniform vec3 uCore,uBeam; varying vec3 vObj; varying vec3 vN; varying vec3 vV;
${NOISE}
void main(){
  vec3 n=normalize(vObj);
  float t=uTime;
  vec3 p=n*2.2+uSeed;
  // magnetar crust: ridged cracks with hot plasma flowing in them
  float w=fbm3(p*1.3+vec3(0.0,t*0.15,0.0));
  float r1=max(1.0-abs(snoise(p*2.2+w*0.8+vec3(t*0.05))),0.0);
  float r2=max(1.0-abs(snoise(p*5.0-w+vec3(0.0,-t*0.1,0.0))),0.0);
  float cracks=pow(r1,6.0)*0.8+pow(r2,8.0)*0.5;
  float gran=snoise(p*9.0+vec3(t*0.4))*0.5+0.5;
  float cap=smoothstep(0.72,0.97,abs(n.y));                 // hot polar caps at the magnetic poles
  float capRing=exp(-pow((abs(n.y)-0.82)*18.0,2.0));          // bright ring around each cap
  float mu=clamp(dot(normalize(vN),normalize(vV)),0.0,1.0);
  vec3 base=mix(uBeam*0.8,uCore,0.25+0.35*gran);
  vec3 col=base*(0.22+0.3*gran);
  col+=mix(uBeam,uCore,0.5)*cracks*1.6;
  col+=vec3(0.85,0.95,1.0)*(cap*2.4+capRing*0.8);
  col*=mix(0.55,1.0,pow(mu,0.5));
  col+=uBeam*pow(1.0-mu,3.0)*0.9;                             // cyan limb
  gl_FragColor=vec4(col*uIntensity,1.0);
}`;

// ---------------------------------------------------------------- tight glow billboard around the core
const glowVert = /* glsl */ `
uniform float uSize; varying vec2 vP;
void main(){ vP=position.xy*uSize; float s=length(modelMatrix[0].xyz); vec4 mv=modelViewMatrix*vec4(0.0,0.0,0.0,1.0); mv.xy+=position.xy*uSize*s; gl_Position=projectionMatrix*mv; }`;
const glowFrag = /* glsl */ `
uniform float uTime,uIntensity,uSize,uAlign; uniform vec3 uCore,uBeam; uniform vec2 uAxis; varying vec2 vP;
void main(){
  float r=length(vP);
  float d=max(r-${CORE_R.toFixed(3)},0.0);
  float hot=exp(-d*20.0)*0.8;
  float mid=exp(-d*5.5)*0.28;
  float far=exp(-r*1.6)*0.07;
  // faint elongation along the projected magnetic axis
  float along=abs(dot(normalize(vP+1e-5),uAxis));
  float aniso=exp(-d*3.5)*pow(along,8.0)*0.22;
  float flare=1.0+uAlign*1.2*exp(-d*3.0);                      // lighthouse moment: when a beam points at us
  float g=(hot+mid+far+aniso)*flare;
  g*=1.0-smoothstep(uSize*0.55,uSize,r);
  vec3 col=mix(uBeam,uCore,clamp(hot*0.4,0.0,1.0))*g;
  col+=vec3(1.0)*hot*0.25*flare;
  gl_FragColor=vec4(col*uIntensity,1.0);
}`;

// ---------------------------------------------------------------- volumetric beams (ray marched inside two cones)
const beamVert = /* glsl */ `
varying vec3 vLocal;
void main(){ vLocal=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
const beamFrag = /* glsl */ `
uniform float uTime,uIntensity,uLen,uSeed,uRmax; uniform vec3 uCamLocal,uCore,uBeam; varying vec3 vLocal;
${NOISE}
float width(float h){ return 0.07+0.12*h; }
void main(){
  vec3 ro=uCamLocal; vec3 seg=vLocal-ro; float tExit=length(seg); vec3 rd=seg/tExit;
  float sgn=vLocal.y>=0.0?1.0:-1.0;
  // slab |y| in [y0,uLen] on this side
  float y0=${(CORE_R + 0.01).toFixed(3)};
  float ta=(sgn*y0-ro.y)/rd.y, tb=(sgn*uLen-ro.y)/rd.y;
  float t0=min(ta,tb);
  if(abs(rd.y)<1e-5) t0=0.0;
  // bounding cylinder entry
  float a=dot(rd.xz,rd.xz), b=dot(ro.xz,rd.xz), c=dot(ro.xz,ro.xz)-uRmax*uRmax;
  float disc=b*b-a*c;
  if(disc>0.0 && a>1e-6) t0=max(t0,(-b-sqrt(disc))/a);
  t0=max(t0,0.0);
  float t1=tExit;
  // occlusion by the neutron star
  float bs=dot(ro,rd), cs=dot(ro,ro)-${(CORE_R * CORE_R).toFixed(4)}; float ds=bs*bs-cs;
  if(ds>0.0){ float th=-bs-sqrt(ds); if(th>0.0) t1=min(t1,th); }
  if(t1<=t0) discard;
  const int N=18;
  float dt=(t1-t0)/float(N);
  float jit=hash21(gl_FragCoord.xy+fract(uTime*7.13)*91.0);
  vec3 acc=vec3(0.0);
  float t=uTime;
  for(int i=0;i<N;i++){
    float tt=t0+(float(i)+jit)*dt;
    vec3 p=ro+rd*tt;
    float h=p.y*sgn;
    float w=width(h);
    float rho=length(p.xz);
    float x=rho/w;
    float prof=exp(-x*x*2.0)+exp(-x*x*0.55)*0.18;
    if(prof<0.004) continue;
    // helical twist + streaming filaments, scaled with the cone so structure stays proportional
    float tw=h*1.4-t*0.9*sgn;
    vec2 q=mat2(cos(tw),-sin(tw),sin(tw),cos(tw))*p.xz/w;
    float n=snoise(vec3(q*1.15,h*1.1-t*3.2)+uSeed+sgn*17.0);
    float fil=0.45+0.9*smoothstep(-0.4,0.8,n);
    // travelling knots of brightness, emitted from the pole
    float knot=0.75+0.6*pow(0.5+0.5*sin(h*3.2-t*7.5+n*0.8),3.0);
    float along=smoothstep(y0-0.02,y0+0.15,h)*exp(-h*0.42)*(1.0-smoothstep(uLen*0.55,uLen,h));
    float near=smoothstep(0.25,1.8,tt);                       // fade right in front of the camera: no full-screen flash
    float hotCore=exp(-x*x*14.0);
    float dens=prof*fil*knot*along*near;
    vec3 col=mix(uBeam,uCore,hotCore*0.8+0.15);
    acc+=col*dens*(1.0+hotCore*1.6);
  }
  acc*=dt*uIntensity*7.0;
  // soft cap so looking straight down a beam saturates gracefully
  float lum=max(dot(acc,vec3(0.3333)),1e-5);
  acc*=1.7*(1.0-exp(-lum/1.7))/lum;
  gl_FragColor=vec4(acc,1.0);
}`;

// ---------------------------------------------------------------- dipole field lines (camera-facing ribbons)
const fieldVert = /* glsl */ `
attribute vec3 aTan; attribute vec4 aInfo; // side, s(0..1), id, kind(0 closed, 1 open)
uniform float uWidth,uResY;
varying float vSide; varying float vS; varying float vId; varying float vKind; varying float vFade; varying float vR;
void main(){
  vec4 mv=modelViewMatrix*vec4(position,1.0);
  vec3 tv=normalize(mat3(modelViewMatrix)*aTan);
  vec3 side=cross(tv,normalize(mv.xyz)); float sl=length(side); side=sl>1e-4?side/sl:vec3(1.0,0.0,0.0);
  float pix=2.0*max(-mv.z,0.01)/(projectionMatrix[1][1]*uResY);
  float w=max(uWidth,pix*1.6);
  vFade=uWidth/w;
  mv.xyz+=side*aInfo.x*w*2.5;
  vSide=aInfo.x; vS=aInfo.y; vId=aInfo.z; vKind=aInfo.w; vR=length(position);
  gl_Position=projectionMatrix*mv;
}`;
const fieldFrag = /* glsl */ `
uniform float uTime,uIntensity; uniform vec3 uField,uAccent,uBeam;
varying float vSide; varying float vS; varying float vId; varying float vKind; varying float vFade; varying float vR;
void main(){
  float x=vSide*2.5;
  float prof=exp(-x*x*1.6)+exp(-x*x*9.0)*0.8;
  float t=uTime;
  // energy pulses travelling pole -> pole (closed) or outward (open)
  float sp=fract(vId*7.31);
  float L=1.0+fract(vId*3.7)*2.0;
  float ph=vS*(2.0+floor(sp*2.0))-t*(0.28+0.12*sp)+vId;
  float f=fract(ph);
  float pulse=exp(-pow((f-0.5)*9.0,2.0));
  float tail=smoothstep(0.0,0.5,f)*step(f,0.5)*0.35;
  float e=pulse+tail*pulse*0.0+tail*0.4;
  // colour: cyan near the star, violet/magenta out on the loops
  float far=smoothstep(0.5,2.2,vR);
  vec3 base=mix(uBeam,mix(uField,uAccent,0.5+0.5*sin(vId*5.0)),far);
  float ends=vKind>0.5 ? (1.0-smoothstep(0.55,1.0,vS)) : 1.0;
  float shimmer=0.8+0.2*sin(vS*40.0-t*3.0+vId*11.0);
  vec3 col=base*(0.15*shimmer)+mix(uAccent,vec3(0.9,0.85,1.0),0.35)*e*1.6;
  col*=prof*vFade*ends*mix(1.0,0.6,vKind)*smoothstep(0.42,0.6,vR);
  gl_FragColor=vec4(col*uIntensity,1.0);
}`;

// ---------------------------------------------------------------- particles
const partVert = /* glsl */ `
attribute vec4 aA; attribute vec4 aB; // see buildParticles
uniform float uTime,uResY,uLen,uSize;
varying vec3 vCol; varying float vA;
uniform vec3 uField,uAccent,uBeam,uCore;
vec3 dip(float L,float th,float ph){ float r=L*sin(th)*sin(th); return r*vec3(sin(th)*cos(ph),cos(th),sin(th)*sin(ph)); }
void main(){
  float t=uTime; vec3 pos; float size; float a;
  if(aB.w<0.5){
    float L=aA.x, ph=aA.y+aB.y*t, th=1.5707963+aA.z*sin(t*aB.x+aA.w);
    pos=dip(L,th,ph);
    vec3 T=normalize(dip(L,th+0.01,ph)-pos);
    vec3 e1=vec3(-sin(ph),0.0,cos(ph)); vec3 e2=normalize(cross(T,e1));
    float g=t*(3.0+aB.x*2.0)+aA.w*7.0;
    pos+=aB.z*(cos(g)*e1+sin(g)*e2);
    float mirror=abs(sin(t*aB.x+aA.w));                       // particles linger (and brighten) near mirror points
    a=0.45+0.7*mirror*mirror;
    float k=clamp((L-1.0)/2.6,0.0,1.0);
    vCol=mix(uBeam*0.9,mix(uAccent,uField,fract(aA.w*3.1)),k);
    size=0.012+0.016*fract(aA.w*13.7);
  } else {
    float sgn=aB.y;
    float u=fract(aA.x+t*aA.w);
    float h=${(CORE_R + 0.05).toFixed(3)}+u*u*0.0+u*(uLen-0.4);
    float w=0.07+0.12*h;
    float ang=aA.z+h*1.4-t*0.9*sgn;
    float rho=w*aA.y*1.1;
    pos=vec3(rho*cos(ang),sgn*h,rho*sin(ang));
    a=smoothstep(0.0,0.08,u)*(1.0-smoothstep(0.35,1.0,u))*0.8;
    vCol=mix(uBeam,uCore,0.5+0.5*(1.0-aA.y));
    size=0.014+0.016*fract(aA.x*17.3);
  }
  vec4 mv=modelViewMatrix*vec4(pos,1.0);
  float px=size*uSize*projectionMatrix[1][1]*uResY*0.5/max(-mv.z,0.01);
  float cl=max(px,1.5);
  vA=a*min(1.0,px*px/(cl*cl))*smoothstep(0.1,0.6,-mv.z);
  gl_PointSize=min(cl,24.0);
  gl_Position=projectionMatrix*mv;
}`;
const partFrag = /* glsl */ `
uniform float uIntensity; varying vec3 vCol; varying float vA;
void main(){
  vec2 c=gl_PointCoord*2.0-1.0; float d=dot(c,c); if(d>1.0) discard;
  float g=exp(-d*4.0)*(1.0-d)+exp(-d*20.0)*0.8;
  gl_FragColor=vec4(vCol*g*vA*uIntensity,1.0);
}`;

// ---------------------------------------------------------------- equatorial pulse rings (spin frame)
const ringVert = /* glsl */ `
varying vec2 vP; varying float vGraze;
void main(){
  vP=position.xy; // plane geometry in xy, rotated into the equatorial plane by the mesh
  vec4 mv=modelViewMatrix*vec4(position,1.0);
  vec3 n=normalize(normalMatrix*vec3(0.0,0.0,1.0));
  vGraze=abs(dot(n,normalize(-mv.xyz)));
  gl_Position=projectionMatrix*mv;
}`;
const ringFrag = /* glsl */ `
uniform float uTime,uIntensity,uOmega,uPeriod,uRmax,uSeed; uniform vec3 uBeam,uField,uAccent,uCore; varying vec2 vP; varying float vGraze;
${NOISE}
void main(){
  float r=length(vP); if(r>uRmax) discard;
  float phi=atan(vP.y,vP.x);
  float t=uTime;
  const float V=0.95; const float R0=0.5;
  // discrete shells, one per half rotation
  float Te=uPeriod*0.5;
  float n0=floor(t/Te);
  vec3 col=vec3(0.0);
  float wob=snoise(vec3(vP*0.7,t*0.15)+uSeed)*0.03;
  for(int k=0;k<7;k++){
    float te=(n0-float(k))*Te; float age=t-te;
    float R=R0+V*age*(1.0-0.04*age)+wob;
    float dr=r-R;
    float life=exp(-age*0.42)*smoothstep(0.0,0.35,age);
    float crest=exp(-dr*dr*700.0)*0.5+exp(-dr*dr*60.0)*0.12;
    float wake=dr<0.0 ? exp(dr*3.0)*0.07 : 0.0;
    float side=mod(n0-float(k),2.0);
    vec3 c=mix(uBeam,mix(uField,uAccent,0.5),smoothstep(0.5,3.5,R));
    col+=c*(crest+wake)*life;
  }
  // continuous spiral arms: where the beams pointed when this radius was emitted (lawn-sprinkler pattern)
  float age=max(r-R0,0.0)/V;
  float pb=3.14159265-uOmega*(t-age);
  float arm=pow(0.5+0.5*cos(phi-pb),10.0)+pow(0.5+0.5*cos(phi-pb-3.14159265),10.0);
  float armN=0.7+0.3*snoise(vec3(r*2.5-t*0.9,phi*2.0,t*0.3)+uSeed);
  col+=mix(uBeam,uAccent,smoothstep(0.8,4.0,r))*arm*armN*exp(-age*0.3)*0.5;
  // inner fade (under the core glow) and outer fade
  col*=smoothstep(0.42,0.9,r)*(1.0-smoothstep(uRmax*0.75,uRmax,r));
  // thin-slab brightening at grazing angles, capped
  col*=min(1.0/max(vGraze,0.05),3.0)*mix(1.0,0.6,1.0-vGraze);
  gl_FragColor=vec4(col*uIntensity,1.0);
}`;

function fieldGeometry(rand, o) {
  const pos = [], tan = [], info = [], idx = [];
  const segs = 110;
  let vbase = 0, lineId = 0;
  const addLine = (pts, kind) => {
    const id = rand() * 10 + lineId++;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
      const s = i / (pts.length - 1);
      for (const side of [-1, 1]) { pos.push(p[0], p[1], p[2]); tan.push(tx, ty, tz); info.push(side, s, id, kind); }
      if (i < pts.length - 1) { const v = vbase + i * 2; idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); }
    }
    vbase += pts.length * 2;
  };
  const dip = (L, th, ph) => { const r = L * Math.sin(th) ** 2; return [r * Math.sin(th) * Math.cos(ph), r * Math.cos(th), r * Math.sin(th) * Math.sin(ph)]; };
  // closed loops in several shells
  const shells = [[1.05, 6], [1.5, 7], [2.1, 8], [2.85, 8], [3.7, 7]];
  for (const [L0, count] of shells) {
    const off = rand() * Math.PI * 2;
    for (let j = 0; j < count; j++) {
      const L = L0 * (0.94 + rand() * 0.12);
      const ph = off + (j + (rand() - 0.5) * 0.35) / count * Math.PI * 2;
      const th0 = Math.asin(Math.sqrt(CORE_R * 0.98 / L));
      const pts = [];
      for (let i = 0; i <= segs; i++) pts.push(dip(L, th0 + (Math.PI - 2 * th0) * i / segs, ph));
      addLine(pts, 0);
    }
  }
  // open field lines flaring out of each pole alongside the beams
  for (const sgn of [1, -1]) {
    for (let j = 0; j < 7; j++) {
      const L = 9 + rand() * 14;
      const ph = (j + rand() * 0.5) / 7 * Math.PI * 2;
      const th0 = Math.asin(Math.sqrt(CORE_R * 0.98 / L));
      const pts = [];
      for (let i = 0; i <= 60; i++) {
        const th = th0 + i * 0.012;
        const p = dip(L, th, ph); if (Math.hypot(...p) > o.beamLength * 0.8) break;
        pts.push([p[0], p[1] * sgn, p[2]]);
      }
      if (pts.length > 4) addLine(pts, 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aTan', new THREE.Float32BufferAttribute(tan, 3));
  g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 4));
  g.setIndex(idx);
  return g;
}

function particleGeometry(rand, nTrapped, nOut) {
  const n = nTrapped + nOut;
  const pos = new Float32Array(n * 3), A = new Float32Array(n * 4), B = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    if (i < nTrapped) {
      const SH = [1.05, 1.5, 2.1, 2.85, 3.7], k = Math.min(4, Math.floor(Math.pow(rand(), 1.25) * 5));
      const L = rand() < 0.75 ? SH[k] * (0.93 + rand() * 0.14) : 0.9 + rand() * 2.8;
      const th0 = Math.asin(Math.sqrt(Math.min(1, (CORE_R + 0.04) / L)));
      const ampMax = Math.PI / 2 - th0;
      A.set([L, rand() * Math.PI * 2, ampMax * (0.25 + 0.72 * rand()), rand() * 100], i * 4);
      B.set([0.5 + rand() * 1.1 / Math.sqrt(L), (rand() < 0.5 ? 1 : -1) * (0.04 + rand() * 0.12), 0.01 + rand() * 0.03 * L, 0], i * 4);
    } else {
      A.set([rand(), Math.pow(rand(), 0.7), rand() * Math.PI * 2, 0.16 + rand() * 0.16], i * 4);
      B.set([0, rand() < 0.5 ? 1 : -1, 0, 1], i * 4);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aA', new THREE.BufferAttribute(A, 4));
  g.setAttribute('aB', new THREE.BufferAttribute(B, 4));
  return g;
}

function beamGeometry(len, rmax) {
  // two closed cone frusta, one per pole (bounding volumes for the ray march)
  const y0 = CORE_R + 0.01, wOf = h => (0.07 + 0.12 * h) * 2.4 + 0.03;
  const pos = [], idx = [];
  for (const sgn of [1, -1]) {
    const c = new THREE.CylinderGeometry(Math.min(rmax, wOf(len)), wOf(y0), len - y0, 28, 1, false);
    c.translate(0, (len + y0) / 2, 0);
    if (sgn < 0) c.scale(1, -1, 1);
    const base = pos.length / 3, p = c.attributes.position.array;
    for (let i = 0; i < p.length; i++) pos.push(p[i]);
    const ix = c.index.array;
    for (let i = 0; i < ix.length; i += 3) {
      if (sgn > 0) idx.push(base + ix[i], base + ix[i + 1], base + ix[i + 2]);
      else idx.push(base + ix[i], base + ix[i + 2], base + ix[i + 1]); // keep winding after the mirror
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

export function create(opts = {}) {
  const o = {
    seed: 1, period: 3.2, tilt: 32, intensity: 1, beamLength: 4.8, beamIntensity: 1, fieldIntensity: 1,
    ringIntensity: 1, particles: 1,
    coreColor: '#d8ecff', beamColor: '#3fb4ff', fieldColor: '#7a4dff', accentColor: '#e04dff', ...opts,
  };
  const rand = rng(o.seed);
  const group = new THREE.Group();
  const spin = new THREE.Group(); group.add(spin);
  const mag = new THREE.Group(); mag.rotation.z = o.tilt * Math.PI / 180; spin.add(mag);

  const uCore = { value: new THREE.Color(o.coreColor) }, uBeam = { value: new THREE.Color(o.beamColor) };
  const uField = { value: new THREE.Color(o.fieldColor) }, uAccent = { value: new THREE.Color(o.accentColor) };
  const uTime = { value: 0 }, uResY = { value: 900 }, uSeed = { value: o.seed * 7.31 % 50 };
  const omega = Math.PI * 2 / o.period;
  const additive = { blending: THREE.AdditiveBlending, transparent: true, depthWrite: false };

  // unit sphere scaled to CORE_R (the shader only uses the normalised position), tessellation by projected size
  const CORE_LODS = [SPHERE_LODS[0], SPHERE_LODS[1], { px: Infinity, w: 64, h: 40 }]; let coreLod;
  const core = new THREE.Mesh(unitSphere(64, 40), new THREE.ShaderMaterial({
    uniforms: { uTime, uSeed, uIntensity: { value: o.intensity }, uCore, uBeam }, vertexShader: coreVert, fragmentShader: coreFrag }));
  core.scale.setScalar(CORE_R);
  mag.add(core);
  core.onBeforeRender = (renderer) => { uResY.value = renderer.getDrawingBufferSize(_v2).y || 900; noteViewH(renderer); };

  const glowSize = 2.4;
  const glowMat = new THREE.ShaderMaterial({
    uniforms: { uTime, uIntensity: { value: o.intensity }, uSize: { value: glowSize }, uAlign: { value: 0 }, uAxis: { value: new THREE.Vector2(0, 1) }, uCore, uBeam },
    vertexShader: glowVert, fragmentShader: glowFrag, ...additive });
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), glowMat);
  glow.frustumCulled = false; glow.renderOrder = 6; group.add(glow);

  const rmax = (0.07 + 0.12 * o.beamLength) * 2.4 + 0.03;
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uTime, uSeed, uIntensity: { value: o.intensity * o.beamIntensity }, uLen: { value: o.beamLength }, uRmax: { value: rmax }, uCamLocal: { value: new THREE.Vector3() }, uCore, uBeam },
    vertexShader: beamVert, fragmentShader: beamFrag, side: THREE.BackSide, ...additive });
  const beams = new THREE.Mesh(beamGeometry(o.beamLength, rmax), beamMat);
  beams.renderOrder = 5; mag.add(beams);

  const fieldMat = new THREE.ShaderMaterial({
    uniforms: { uTime, uResY, uIntensity: { value: o.intensity * o.fieldIntensity }, uWidth: { value: 0.006 }, uField, uAccent, uBeam },
    vertexShader: fieldVert, fragmentShader: fieldFrag, side: THREE.DoubleSide, ...additive });
  const field = new THREE.Mesh(fieldGeometry(rand, o), fieldMat);
  field.frustumCulled = false; field.renderOrder = 3; mag.add(field);

  const nT = Math.round(7000 * o.particles), nO = Math.round(2500 * o.particles);
  const partMat = new THREE.ShaderMaterial({
    uniforms: { uTime, uResY, uLen: { value: o.beamLength }, uSize: { value: 1 }, uIntensity: { value: o.intensity }, uField, uAccent, uBeam, uCore },
    vertexShader: partVert, fragmentShader: partFrag, ...additive });
  const parts = new THREE.Points(particleGeometry(rand, nT, nO), partMat);
  parts.frustumCulled = false; parts.renderOrder = 4; mag.add(parts);

  const ringR = 5.2;
  const ringMat = new THREE.ShaderMaterial({
    uniforms: { uTime, uSeed, uIntensity: { value: o.intensity * o.ringIntensity }, uOmega: { value: omega }, uPeriod: { value: o.period }, uRmax: { value: ringR }, uBeam, uField, uAccent, uCore },
    vertexShader: ringVert, fragmentShader: ringFrag, side: THREE.DoubleSide, ...additive });
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(ringR * 2, ringR * 2), ringMat);
  ring.rotation.x = -Math.PI / 2; ring.renderOrder = 2; group.add(ring);

  const _v2 = new THREE.Vector2(), _inv = new THREE.Matrix4(), _cam = new THREE.Vector3();
  const _ax = new THREE.Vector3(), _c = new THREE.Vector3(), _tv = new THREE.Vector3();
  return {
    group, radius: 5,
    update(time, dt, camera) {
      uTime.value = time;
      spin.rotation.y = omega * time;
      group.updateWorldMatrix(true, true);
      if (camera) {
        const li = lodIndex(CORE_LODS, projectedPx(core, CORE_R, camera), coreLod);
        if (li !== coreLod) { coreLod = li; core.geometry = unitSphere(CORE_LODS[li].w, CORE_LODS[li].h); }
        camera.updateMatrixWorld();
        _cam.setFromMatrixPosition(camera.matrixWorld);
        _inv.copy(beams.matrixWorld).invert();
        beamMat.uniforms.uCamLocal.value.copy(_cam).applyMatrix4(_inv);
        // magnetic axis in world, alignment with the view direction (lighthouse flare) and its screen direction
        _ax.set(0, 1, 0).transformDirection(mag.matrixWorld);
        _c.setFromMatrixPosition(group.matrixWorld);
        _tv.copy(_cam).sub(_c).normalize();
        const al = Math.abs(_ax.dot(_tv));
        glowMat.uniforms.uAlign.value = Math.pow(Math.max(0, (al - 0.8) / 0.2), 3);
        _tv.copy(_ax).transformDirection(camera.matrixWorldInverse);
        const l = Math.hypot(_tv.x, _tv.y) || 1;
        glowMat.uniforms.uAxis.value.set(_tv.x / l, _tv.y / l);
      }
    },
  };
}
