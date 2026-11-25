// Deep-space backdrop: a nebula baked once into a cubemap, live twinkling stars, and near dust for parallax.
import * as THREE from 'three';
import { NOISE } from './glsl.js';

const BAND = new THREE.Vector3(0.35, 0.86, -0.36).normalize(); // normal of the galactic plane

const nebulaFrag = /* glsl */ `
varying vec3 vDir; uniform vec3 uBand;
${NOISE}
float ridge(vec3 p){ float a=0.5,s=0.0; for(int i=0;i<5;i++){ s+=a*(1.0-abs(snoise(p))); p=p*2.05+vec3(5.2,1.3,8.1); a*=0.5; } return s; }
void main(){
  vec3 d=normalize(vDir);
  vec3 q=d*1.35;
  vec3 w=vec3(fbm(q+vec3(1.7,9.2,3.1)),fbm(q+vec3(8.3,2.8,5.5)),fbm(q+vec3(4.1,6.6,0.4)));
  vec3 w2=vec3(fbm(q*1.9+2.4*w+vec3(3.3,1.1,7.7)),fbm(q*1.9+2.4*w+vec3(6.1,4.4,2.2)),fbm(q*1.9+2.4*w+vec3(0.5,8.8,1.9)));
  float f=fbm(q*1.2+1.9*w2)*0.5+0.5;
  float g=fbm(q*2.3-1.4*w+vec3(11.0))*0.5+0.5;
  float lat=dot(d,uBand); float band=exp(-lat*lat*7.0); float core=exp(-lat*lat*40.0);
  float reg=0.9*smoothstep(0.12,0.5,fbm3(d*0.85+vec3(50.0,20.0,80.0))*0.5+0.5);
  float rich=max(band,reg);
  float dens=smoothstep(0.36,0.94,f*(0.60+0.68*rich));
  vec3 violet=vec3(0.20,0.07,0.42), rose=vec3(0.62,0.11,0.33), teal=vec3(0.03,0.33,0.42), blue=vec3(0.05,0.11,0.40), amber=vec3(0.75,0.36,0.12);
  vec3 col=mix(blue,violet,smoothstep(0.2,0.7,w.x*0.5+0.5));
  col=mix(col,teal,smoothstep(0.45,0.85,w2.y*0.5+0.5)*0.75);
  col=mix(col,rose,smoothstep(0.5,0.9,g)*0.8);
  col=mix(col,amber,core*smoothstep(0.4,0.9,f)*0.55);
  col*=dens*dens*0.62;
  // large dark voids so the bright marbling reads as clouds in front of deep space
  col*=mix(0.5,1.0,smoothstep(0.36,0.62,fbm3(d*0.62+vec3(90.0,33.0,61.0))*0.5+0.5));
  // filaments and dark dust lanes
  float fil=pow(ridge(q*2.2+w*1.3),3.0); col+=fil*0.035*mix(teal,rose,g)*(0.6+1.4*band);
  float lane=smoothstep(0.52,0.82,fbm(q*3.1+w2*1.6+vec3(20.0))*0.5+0.5); col*=1.0-0.78*lane*(0.45+0.55*band);
  // milky band of unresolved stars
  col+=vec3(0.085,0.075,0.10)*core*(0.5+0.8*f)*(1.0-0.8*lane);
  col+=vec3(0.004,0.006,0.016);
  gl_FragColor=vec4(col,1.0);
}`;

const bakeVert = `varying vec3 vDir; void main(){ vDir=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;
// Tangential flow field (stored 0..1) that the live sky shader advects the baked nebula along.
const flowFrag = /* glsl */ `
varying vec3 vDir;
${NOISE}
void main(){
  vec3 d=normalize(vDir); vec3 q=d*1.15;
  vec3 f=vec3(fbm3(q+vec3(31.0,4.0,9.0)),fbm3(q+vec3(7.0,53.0,2.0)),fbm3(q+vec3(13.0,8.0,71.0)));
  f=cross(d,f);                      // swirl around the view direction: divergence-free on the sphere
  gl_FragColor=vec4(f*0.9+0.5,1.0);
}`;

function bakeCube(renderer, fragmentShader, size, type) {
  const rt = new THREE.WebGLCubeRenderTarget(size, { type, generateMipmaps: false });
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({ side: THREE.BackSide, uniforms: { uBand: { value: BAND } }, vertexShader: bakeVert, fragmentShader })));
  const tm = renderer.toneMapping; renderer.toneMapping = THREE.NoToneMapping;
  new THREE.CubeCamera(0.1, 100, rt).update(renderer, s);
  renderer.toneMapping = tm;
  return rt.texture;
}

// The nebula is too expensive to evaluate per frame (dozens of noise octaves), so it is baked once and then
// animated with flow-mapping: two copies advected along the flow field, half a cycle apart, cross-faded so
// the reset of each is never visible. Costs two cubemap reads per pixel.
const skyFrag = /* glsl */ `
uniform samplerCube tNebula,tFlow; uniform float uTime,uFade,uTintAmt,uResY; uniform vec3 uTint; varying vec3 vDir;
void main(){
  vec3 d=normalize(vDir);
  vec3 f=(textureCube(tFlow,d).xyz-0.5)/0.9;
  float cyc=uTime/46.0; float p0=fract(cyc), p1=fract(cyc+0.5);
  const float amp=0.42;
  vec3 c0=textureCube(tNebula,normalize(d-f*amp*(p0-0.5))).rgb;
  vec3 c1=textureCube(tNebula,normalize(d-f*amp*(p1-0.5))).rgb;
  vec3 col=mix(c0,c1,abs(2.0*p0-1.0));
  // slow breathing of the glow so it never sits still even where the flow is weak
  float breathe=1.0+0.10*sin(uTime*0.11+d.x*3.0+d.y*2.0)+0.07*sin(uTime*0.07-d.z*4.0+f.x*6.0);
  // colour-heavy toward the top of the screen, calmer toward the bottom
  float sy=gl_FragCoord.y/uResY; col*=mix(0.34,1.42,smoothstep(0.08,0.9,sy));
  float lum=dot(col,vec3(0.3,0.5,0.2));
  col=mix(col,lum*uTint*1.5,0.22*uTintAmt)*(1.0-0.12*uTintAmt);
  gl_FragColor=vec4(col*breathe*uFade,1.0);
}`;

export function createSky(renderer) {
  const mat = new THREE.ShaderMaterial({ side: THREE.BackSide, depthTest: false, depthWrite: false,
    uniforms: { tNebula: { value: bakeCube(renderer, nebulaFrag, 1024, THREE.HalfFloatType) }, tFlow: { value: bakeCube(renderer, flowFrag, 128, THREE.UnsignedByteType) }, uTime: { value: 0 }, uFade: { value: 1 }, uTint: { value: new THREE.Color(1, 1, 1) }, uTintAmt: { value: 0 }, uResY: { value: 1 } },
    vertexShader: `varying vec3 vDir; void main(){ vDir=position; vec4 mv=viewMatrix*vec4(position,0.0); gl_Position=projectionMatrix*vec4(mv.xyz,1.0); }`,
    fragmentShader: skyFrag });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), mat);
  mesh.frustumCulled = false; mesh.renderOrder = -100;
  return { mesh, nebula: mat.uniforms.tNebula.value, update(time, tint, amt = 0, resY = 1) { mat.uniforms.uTime.value = time; mat.uniforms.uResY.value = resY; if (tint) mat.uniforms.uTint.value.copy(tint); mat.uniforms.uTintAmt.value = amt; } };
}

function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const starVert = /* glsl */ `
attribute float aSize; attribute float aPhase; attribute vec3 aColor; uniform float uTime,uPx,uFade; varying vec3 vColor; varying float vI;
void main(){
  vec4 mv=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mv;
  float tw=0.78+0.22*sin(uTime*(0.6+aPhase*2.4)+aPhase*40.0)*sin(uTime*0.37+aPhase*17.0);
  float s=aSize*uPx; gl_PointSize=max(s,1.6);
  vI=tw*min(1.0,s*s/2.56)*uFade*smoothstep(0.0,0.3,uFade-aPhase*0.7); vColor=aColor*(0.6+aSize*0.42);
}`;
const starFrag = /* glsl */ `
varying vec3 vColor; varying float vI;
void main(){ vec2 c=gl_PointCoord-0.5; float r=length(c)*2.0; float a=exp(-r*r*7.5)*smoothstep(1.0,0.7,r); gl_FragColor=vec4(vColor*a*vI,1.0); }`;

export function createStars(count = 9000) {
  const r = rng(42), pos = new Float32Array(count * 3), size = new Float32Array(count), phase = new Float32Array(count), col = new Float32Array(count * 3);
  const temps = [[0.62, 0.74, 1.0], [0.8, 0.87, 1.0], [1, 1, 1], [1.0, 0.93, 0.78], [1.0, 0.8, 0.58], [1.0, 0.64, 0.45]];
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    for (;;) { // rejection-sample toward the galactic band
      v.set(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1); if (v.lengthSq() > 1 || v.lengthSq() < 1e-4) continue; v.normalize();
      const lat = v.dot(BAND); if (r() < 0.22 + 0.78 * Math.exp(-lat * lat * 9)) break;
    }
    v.multiplyScalar(900); pos.set([v.x, v.y, v.z], i * 3);
    const m = Math.pow(r(), 7.5); size[i] = 1.1 + m * 5.2; phase[i] = r();
    const t = temps[Math.min(5, Math.floor(Math.pow(r(), 0.8) * 6))]; col.set(t, i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1)); g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  const m = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uPx: { value: 1 }, uFade: { value: 1 } }, vertexShader: starVert, fragmentShader: starFrag,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: true });
  const pts = new THREE.Points(g, m); pts.frustumCulled = false; pts.renderOrder = -10;
  return pts;
}

const dustVert = /* glsl */ `
attribute float aPhase; uniform float uTime,uScale; varying float vA;
void main(){
  vec3 p=position+vec3(sin(uTime*0.05+aPhase*30.0),cos(uTime*0.04+aPhase*50.0),sin(uTime*0.045+aPhase*70.0))*0.9;
  vec4 mv=modelViewMatrix*vec4(p,1.0); gl_Position=projectionMatrix*mv;
  float d=-mv.z; float s=(0.05+aPhase*0.09)*uScale/max(d,0.1); gl_PointSize=clamp(s,1.0,14.0);
  vA=smoothstep(0.6,3.0,d)*smoothstep(140.0,40.0,d)*(0.35+0.65*aPhase)*min(1.0,s);
}`;
const dustFrag = /* glsl */ `
varying float vA; void main(){ vec2 c=gl_PointCoord-0.5; float r=length(c)*2.0; float a=exp(-r*r*5.0)*smoothstep(1.0,0.5,r); gl_FragColor=vec4(vec3(0.62,0.74,1.0)*a*vA*0.5,1.0); }`;

export function createDust(count = 2600, radius = 85) {
  const r = rng(7), pos = new Float32Array(count * 3), phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const u = r() * 2 - 1, th = r() * Math.PI * 2, rad = radius * Math.cbrt(r()), s = Math.sqrt(1 - u * u);
    pos.set([rad * s * Math.cos(th), rad * u * 0.7, rad * s * Math.sin(th)], i * 3); phase[i] = r();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  const m = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uScale: { value: 800 } }, vertexShader: dustVert, fragmentShader: dustFrag,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
  const pts = new THREE.Points(g, m); pts.frustumCulled = false;
  return pts;
}
