// Graph edges: camera-facing energy ribbons along gentle Bezier arcs, with pulses and drifting motes
// travelling outward from the parent. One draw call for all ribbons, one for all motes.
import * as THREE from 'three';
import { NOISE } from './glsl.js';

const MAX_EDGES = 32, SEG = 56, MOTES = 70;
const BEZ = /* glsl */ `
vec3 bez(vec3 a,vec3 c,vec3 b,float t){ float u=1.0-t; return u*u*a+2.0*u*t*c+t*t*b; }
vec3 bezT(vec3 a,vec3 c,vec3 b,float t){ return 2.0*(1.0-t)*(c-a)+2.0*t*(b-c); }`;

const ribbonVert = /* glsl */ `
attribute float aT,aSide,aEdge; attribute vec3 aA,aB,aC,aColA,aColB; attribute vec2 aClear;
uniform float uPxWorld,uActive[${MAX_EDGES}]; varying float vT,vSide,vActive,vSeed,vPx; varying vec3 vColA,vColB; varying vec2 vClear;
${BEZ}
void main(){
  vec3 p=bez(aA,aC,aB,aT); vec3 tg=normalize(bezT(aA,aC,aB,aT));
  vec4 mv=viewMatrix*vec4(p,1.0); vec3 tv=normalize((viewMatrix*vec4(tg,0.0)).xyz);
  vec3 side=normalize(cross(tv,normalize(mv.xyz)));
  float px=uPxWorld*(-mv.z);            // world size of one pixel at this depth
  float w=max(0.085,px*5.0);             // half-width: never thinner than ~5px so the core stays anti-aliased
  mv.xyz+=side*aSide*w; gl_Position=projectionMatrix*mv;
  vT=aT; vSide=aSide; vActive=uActive[int(aEdge)]; vSeed=aEdge*0.371; vColA=aColA; vColB=aColB; vClear=aClear; vPx=px/w;
}`;
const ribbonFrag = /* glsl */ `
uniform float uTime,uFade; varying float vT,vSide,vActive,vSeed,vPx; varying vec3 vColA,vColB; varying vec2 vClear;
${NOISE}
void main(){
  float x=abs(vSide);
  float coreW=max(vPx*1.1,0.05);       // core about a pixel wide
  float core=exp(-x*x/(coreW*coreW));
  float halo=exp(-x*x*9.0)*0.16;
  // pulses travel parent -> child
  float ph=vT*2.0-uTime*0.16+vSeed; float f=fract(ph);
  float pulse=exp(-pow((f-0.5)*7.0,2.0));
  float fine=0.5+0.5*sin(vT*90.0-uTime*2.2+vSeed*20.0);
  float ends=smoothstep(vClear.x,vClear.x+0.10,vT)*smoothstep(1.0-vClear.y,1.0-vClear.y-0.10,vT);
  float act=mix(1.0,3.2,vActive);
  float I=(core*(0.36+0.10*fine+0.8*pulse)+halo*(0.4+1.2*pulse))*act;
  vec3 col=mix(vColA,vColB,smoothstep(0.1,0.9,vT)); col=mix(col,vec3(1.0),pulse*core*0.28);
  gl_FragColor=vec4(col*I*ends*uFade*smoothstep(1.0,0.75,x),1.0);
}`;

const moteVert = /* glsl */ `
attribute float aT0,aSpeed,aEdge; attribute vec3 aA,aB,aC,aOff,aColA,aColB; attribute vec2 aClear;
uniform float uTime,uScale,uActive[${MAX_EDGES}],uFade; varying vec3 vCol; varying float vI;
${BEZ}
void main(){
  float t=fract(aT0+uTime*aSpeed);
  vec3 p=bez(aA,aC,aB,t)+aOff*(0.25+0.75*sin(t*6.2831+aT0*40.0));
  vec4 mv=viewMatrix*vec4(p,1.0); gl_Position=projectionMatrix*mv;
  float act=uActive[int(aEdge)];
  float s=(0.05+0.07*fract(aT0*91.7))*uScale/max(-mv.z,0.1)*(1.0+act*0.6); gl_PointSize=clamp(s,1.2,10.0);
  float ends=smoothstep(aClear.x,aClear.x+0.08,t)*smoothstep(1.0-aClear.y,1.0-aClear.y-0.08,t);
  vI=ends*(0.45+1.5*act)*min(1.0,s*0.6)*uFade; vCol=mix(aColA,aColB,t);
}`;
const moteFrag = /* glsl */ `
varying vec3 vCol; varying float vI; void main(){ vec2 c=gl_PointCoord-0.5; float r=length(c)*2.0; float a=exp(-r*r*6.0)*smoothstep(1.0,0.5,r); gl_FragColor=vec4(mix(vCol,vec3(1.0),0.35)*a*vI,1.0); }`;

// edges: [{ a:Vector3, b:Vector3, colA:Color, colB:Color, clearA, clearB }] (clear = radius kept empty around each end)
export function createEdges(edges) {
  const n = edges.length, V = (SEG + 1) * 2;
  const mk = (len, size) => new Float32Array(len * size);
  const rb = { aT: mk(n * V, 1), aSide: mk(n * V, 1), aEdge: mk(n * V, 1), aA: mk(n * V, 3), aB: mk(n * V, 3), aC: mk(n * V, 3), aColA: mk(n * V, 3), aColB: mk(n * V, 3), aClear: mk(n * V, 2) };
  const mt = { aT0: mk(n * MOTES, 1), aSpeed: mk(n * MOTES, 1), aEdge: mk(n * MOTES, 1), aA: mk(n * MOTES, 3), aB: mk(n * MOTES, 3), aC: mk(n * MOTES, 3), aOff: mk(n * MOTES, 3), aColA: mk(n * MOTES, 3), aColB: mk(n * MOTES, 3), aClear: mk(n * MOTES, 2) };
  const index = [];
  let seed = 1; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const mid = new THREE.Vector3(), dir = new THREE.Vector3(), perp = new THREE.Vector3(), ctrl = new THREE.Vector3();
  edges.forEach((e, k) => {
    const len = e.a.distanceTo(e.b);
    dir.subVectors(e.b, e.a).normalize(); mid.addVectors(e.a, e.b).multiplyScalar(0.5);
    perp.set(0, 1, 0).cross(dir); if (perp.lengthSq() < 1e-3) perp.set(1, 0, 0); perp.normalize().applyAxisAngle(dir, k * 2.4);
    ctrl.copy(mid).addScaledVector(perp, len * 0.13);
    const clear = [Math.min(0.4, e.clearA / len), Math.min(0.4, e.clearB / len)];
    const put = (o, name, i, ...v) => o[name].set(v, i * v.length);
    for (let s = 0; s <= SEG; s++) for (let side = 0; side < 2; side++) {
      const i = k * V + s * 2 + side;
      rb.aT[i] = s / SEG; rb.aSide[i] = side ? 1 : -1; rb.aEdge[i] = k;
      put(rb, 'aA', i, e.a.x, e.a.y, e.a.z); put(rb, 'aB', i, e.b.x, e.b.y, e.b.z); put(rb, 'aC', i, ctrl.x, ctrl.y, ctrl.z);
      put(rb, 'aColA', i, e.colA.r, e.colA.g, e.colA.b); put(rb, 'aColB', i, e.colB.r, e.colB.g, e.colB.b); put(rb, 'aClear', i, clear[0], clear[1]);
    }
    for (let s = 0; s < SEG; s++) { const i = k * V + s * 2; index.push(i, i + 1, i + 2, i + 1, i + 3, i + 2); }
    for (let m = 0; m < MOTES; m++) {
      const i = k * MOTES + m;
      mt.aT0[i] = rnd(); mt.aSpeed[i] = (0.5 + rnd()) * 1.1 / len; mt.aEdge[i] = k;
      put(mt, 'aA', i, e.a.x, e.a.y, e.a.z); put(mt, 'aB', i, e.b.x, e.b.y, e.b.z); put(mt, 'aC', i, ctrl.x, ctrl.y, ctrl.z);
      put(mt, 'aOff', i, (rnd() - 0.5) * 0.7, (rnd() - 0.5) * 0.7, (rnd() - 0.5) * 0.7);
      put(mt, 'aColA', i, e.colA.r, e.colA.g, e.colA.b); put(mt, 'aColB', i, e.colB.r, e.colB.g, e.colB.b); put(mt, 'aClear', i, clear[0], clear[1]);
    }
  });
  const sizes = { aT: 1, aSide: 1, aEdge: 1, aT0: 1, aSpeed: 1, aClear: 2 };
  const geo = (o, count) => { const g = new THREE.BufferGeometry(); for (const k in o) g.setAttribute(k, new THREE.BufferAttribute(o[k], sizes[k] || 3)); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3)); return g; };
  const active = new Float32Array(MAX_EDGES);
  const common = { blending: THREE.AdditiveBlending, transparent: true, depthWrite: false };
  const rg = geo(rb, n * V); rg.setIndex(index);
  const ribbons = new THREE.Mesh(rg, new THREE.ShaderMaterial({ ...common, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uPxWorld: { value: 0.001 }, uActive: { value: active }, uFade: { value: 1 } }, vertexShader: ribbonVert, fragmentShader: ribbonFrag }));
  const motes = new THREE.Points(geo(mt, n * MOTES), new THREE.ShaderMaterial({ ...common,
    uniforms: { uTime: { value: 0 }, uScale: { value: 800 }, uActive: { value: active }, uFade: { value: 1 } }, vertexShader: moteVert, fragmentShader: moteFrag }));
  ribbons.frustumCulled = motes.frustumCulled = false;
  const group = new THREE.Group(); group.add(ribbons, motes);
  const targets = new Float32Array(MAX_EDGES);
  return {
    group,
    setActive(indices) { targets.fill(0); for (const i of indices) targets[i] = 1; },
    update(time, dt, camera, viewportH, fade = 1) {
      for (let i = 0; i < n; i++) active[i] += (targets[i] - active[i]) * Math.min(1, dt * 5);
      const pxWorld = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / viewportH;
      ribbons.material.uniforms.uTime.value = motes.material.uniforms.uTime.value = time;
      ribbons.material.uniforms.uFade.value = motes.material.uniforms.uFade.value = fade;
      ribbons.material.uniforms.uPxWorld.value = pxWorld; motes.material.uniforms.uScale.value = 1 / pxWorld;
    },
  };
}
