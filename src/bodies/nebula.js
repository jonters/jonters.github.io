// Emission nebula / stellar nursery: a bounded ray-marched emission-absorption volume (gas lobes, dust lanes,
// embedded stars lighting the gas from within, stars composited at their true depth so dust hides them),
// plus one Points layer of edge wisps and faint embedded stars for parallax and sparkle.
// create({ seed, intensity, speed, scale, gas, dust, colorH, colorO, colorDust }) -> { group, radius, update }
import * as THREE from 'three';
import { NOISE } from '../glsl.js';

function rng(seed) {
  let a = (Math.floor(seed * 9973) ^ 0x9e3779b9) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function randDir(r) { const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z); return new THREE.Vector3(Math.cos(a) * s, z, Math.sin(a) * s); }

const N_LOBES = 8, N_LIGHTS = 6, N_STARS = 12, STEPS = 30;

const volVert = /* glsl */ `
varying vec3 vObj;
void main(){ vObj=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`;

const volFrag = /* glsl */ `
precision highp float;
uniform vec3 uCam, uRight, uUp;
uniform float uTime, uPix, uR, uSeed, uInt, uGas, uDust, uDetail;
uniform vec4 uLobes[${N_LOBES}];   // xyz centre, w = 1/r^2
uniform vec4 uLights[${N_LIGHTS}]; // xyz, w = power (0 = central cluster)
uniform vec4 uStars[${N_STARS}];   // xyz, w = core size
uniform vec4 uStarCol[${N_STARS}]; // rgb, w = twinkle phase
uniform vec3 uColH, uColO, uColD, uColV;
varying vec3 vObj;
${NOISE}

// cheap churning warp (trig) + lobes, two/three simplex octaves for the gas, one radially stretched field that
// carves dust pillars pointing at the central cluster.
float field(vec3 p, float t, out float dust, out float shade){
  vec3 w=p;
  w+=0.20*sin(w.yzx*1.7+vec3(1.3,2.1,0.4)*t+uSeed);
  w+=0.09*sin(w.zxy*3.3-vec3(0.7,1.1,1.6)*t+uSeed*1.7);
  vec3 q=w*1.2+vec3(0.0,t*0.3,uSeed);
  float n1=snoise(q);
  // the envelope multiplies both gas and dust: where it is exactly 0 (the outer shell of the bounding sphere) the
  // sample is empty, so skip the other noise octaves and the lobe sum (same result)
  float env=smoothstep(uR,uR*0.45,length(p)*(1.0+0.3*n1));
  if(env<=0.0){ dust=0.0; shade=0.0; return 0.0; }
  float lobe=0.0;
  for(int i=0;i<${N_LOBES};i++){ vec3 d=w-uLobes[i].xyz; lobe+=exp(-dot(d,d)*uLobes[i].w); }
  float n2=snoise(q*2.3+vec3(5.2,-t*0.45,1.7));
  float n=n1*0.62+n2*0.30;
  if(uDetail>0.01) n+=uDetail*0.14*snoise(q*5.1-vec3(t*0.5,0.0,3.1));
  float r=length(w);
  vec3 dir=w/max(r,1e-3);
  float cav=smoothstep(0.18,0.75,r+0.2*n1);
  float g=lobe*(0.40+0.85*n);
  float soft=lobe*0.05*(1.0+n);
  // filaments in the outskirts: ridges of the gas noise where the lobes thin out
  float fil=pow(1.0-abs(n1*0.75+n2*0.35),18.0)*smoothstep(0.02,0.22,lobe)*(1.0-smoothstep(0.35,0.9,lobe));
  soft+=fil*0.3;
  g=(max(g-0.16,0.0)+soft)*env*cav;
  // pillars: noise on the direction sphere, slowly varying with radius -> radial columns with eroded edges
  float pn=snoise(dir*2.1+vec3(r*0.45)+vec3(9.1,uSeed,-t*0.2))+0.22*n2;
  float pil=smoothstep(0.3,0.76,pn)*smoothstep(0.38,0.85,r);
  // thin lanes where the second octave crosses zero
  float lane=pow(1.0-abs(n2),9.0)*smoothstep(0.15,0.5,lobe);
  dust=(pil*1.7+lane*0.7)*env*smoothstep(0.2,0.6,lobe);
  shade=n;
  return g;
}

void main(){
  vec3 ro=uCam; vec3 rd=normalize(vObj-uCam);
  float b=dot(ro,rd); float c=dot(ro,ro)-uR*uR; float h=b*b-c; if(h<=0.0) discard;
  h=sqrt(h); float t0=max(-b-h,0.0), t1=-b+h; if(t1<=t0) discard;
  float L=t1-t0; float dt=L/float(${STEPS});
  float jit=hash21(gl_FragCoord.xy+fract(uSeed)*91.0);
  float tt=uTime*0.15;
  // star glow profiles along this ray (screen-space shape, composited at their depth)
  float sT[${N_STARS}]; vec3 sG[${N_STARS}];
  for(int i=0;i<${N_STARS}; i++){
    vec3 s=uStars[i].xyz-ro; float ts=dot(s,rd); vec3 off=s-rd*ts; float rr=length(off);
    float ang=rr/max(ts,1e-3);
    float px=uPix; // radians per pixel
    float core=uStars[i].w/max(ts,1e-3);
    float wcore=max(core,px*1.1);
    float tw=0.82+0.18*sin(uTime*(1.3+uStarCol[i].w*0.37)+uStarCol[i].w*6.0)*sin(uTime*0.71+uStarCol[i].w*3.0);
    float amp=(core*core)/(wcore*wcore); // energy conserving when sub-pixel
    float g=amp*exp(-ang*ang/(wcore*wcore))*6.0 + 0.5*exp(-ang/(core*2.5+px)) + 0.08*exp(-ang/(core*9.0+px*3.0));
    // diffraction spikes for the bigger ones (screen aligned), physical length so they stay inside the cloud
    vec2 sp=abs(vec2(dot(off,uRight),dot(off,uUp)))/max(ts,1e-3);
    float sw=max(core*0.35,px*0.6), sl=uStars[i].w*9.0/max(ts,1e-3);
    float spike=(exp(-sp.y/sw-sp.x/sl)+exp(-sp.x/sw-sp.y/sl))*smoothstep(0.008,0.024,uStars[i].w)*smoothstep(0.8,2.5,ts);
    g+=spike*0.5;
    sT[i]=ts; sG[i]=uStarCol[i].rgb*g*tw;
  }
  vec3 col=vec3(0.0); float T=1.0;
  float t=t0+dt*jit;
  // Each embedded star is composited once, at the step whose sample interval [t-dt/2, t+dt/2] holds its closest
  // approach, weighted by the transmittance in front of that step. Testing all ${N_STARS} stars at every step cost
  // about a quarter of the shader, so record the transmittance per step and add the stars after the march (same sum).
  float Tk[${STEPS}]; int kEnd=${STEPS};
  for(int k=0;k<${STEPS};k++){
    Tk[k]=T;
    vec3 p=ro+rd*t;
    float dust, shade; float g=field(p,tt,dust,shade)*uGas; dust*=uDust;
    float sig=g*2.0+dust*4.5;
    if(g!=0.0||dust!=0.0){ // else an empty sample: no emission, no absorption (the stars still composite)
    // lighting from embedded stars
    float Isum=0.0; float Icen=0.0;
    float Iloc=0.0;
    for(int i=0;i<${N_LIGHTS};i++){ vec3 d=uLights[i].xyz-p; float dd=dot(d,d); float l=uLights[i].w/(dd+0.2); Isum+=l; if(i==0) Icen=l; else Iloc+=uLights[i].w*exp(-dd*14.0); }
    Isum=Isum/(1.0+Isum*0.3);
    float ion=Icen/(Icen+1.2);
    vec3 gasC=mix(uColH, uColO, smoothstep(0.2,0.72,ion)) ;
    gasC=mix(uColV, gasC, smoothstep(0.05,0.9,Isum*0.6));
    vec3 em=g*(gasC*Isum*(0.55+0.9*max(shade+0.3,0.0))+(uColH*0.4+uColV*0.22)*(1.0-0.75*ion));
    em+=(g+dust*0.7)*uColD*Iloc*1.6;
    em+=dust*(uColD*smoothstep(1.2,6.0,Isum)*1.2+uColV*0.05);
    float a=exp(-sig*dt);
    // energy-correct integration of emission over the step
    col+=T*em*(1.0-a)/max(sig,1e-4);
    T*=a;
    }
    t+=dt;
    if(T<0.02){ kEnd=k+1; break; }
  }
  // stars whose closest point falls inside one of the steps that were marched
  float tA=t0+dt*jit;
  for(int i=0;i<${N_STARS};i++){ float kf=floor((sT[i]-tA)/dt+0.5); if(kf>=0.0 && kf<float(kEnd)) col+=Tk[int(kf)]*sG[i]; }
  // any star in front of the first sample / behind the last
  for(int i=0;i<${N_STARS};i++){ if(sT[i]<t0+dt*(jit-0.5)) col+=sG[i]; }
  col*=uInt*1.05;
  gl_FragColor=vec4(col,1.0-T);
}`;

const ptsVert = /* glsl */ `
attribute vec4 aData; // x: size, y: kind (0 wisp, 1 star), z: phase, w: brightness
attribute vec3 aColor;
uniform float uTime, uScale, uPixH, uSeed;
varying vec3 vCol; varying float vKind;
void main(){
  vec3 p=position;
  float t=uTime*0.15;
  p+=0.20*sin(p.yzx*1.7+vec3(1.3,2.1,0.4)*t+uSeed);
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  float d=-mv.z;
  float sz=aData.x*uScale;
  float px=sz*uPixH/max(d,0.05);
  float fadeNear=smoothstep(0.6,2.2,d);
  float tw=aData.y>0.5 ? 0.6+0.4*sin(uTime*(0.9+aData.z)+aData.z*17.0) : 0.8+0.2*sin(uTime*0.15+aData.z*9.0);
  float bright=aData.w*tw*fadeNear;
  // keep sub-pixel points from vanishing: shrink to 1.5px and fold area into brightness
  float pc=max(px,1.5); float fold=min(1.0,(px*px)/(pc*pc)); bright*=aData.y>0.5 ? mix(1.0,fold,0.75)*(0.35+0.65*smoothstep(30.0,10.0,d)) : fold;
  gl_PointSize=min(pc,64.0);
  vCol=aColor*bright; vKind=aData.y;
  gl_Position=projectionMatrix*mv;
}`;
const ptsFrag = /* glsl */ `
varying vec3 vCol; varying float vKind;
void main(){
  vec2 c=gl_PointCoord*2.0-1.0; float r2=dot(c,c); if(r2>1.0) discard;
  float a = vKind>0.5 ? exp(-r2*9.0)+0.15*exp(-r2*2.5) : (1.0-r2)*(1.0-r2)*exp(-r2*1.5);
  gl_FragColor=vec4(vCol*a,1.0);
}`;

export function create(opts = {}) {
  const o = {
    seed: 1, intensity: 1, speed: 1, scale: 1, gas: 1, dust: 1, wisps: 1,
    colorH: '#ff2f7a', colorO: '#0fb8cc', colorDust: '#ffae4a', colorShadow: '#3a1aa8', ...opts,
  };
  const r = rng(o.seed);
  const group = new THREE.Group();
  const R = 2.5;

  // lobes: one central mass and billowing satellites
  const lobes = [new THREE.Vector4(0, 0, 0, 1 / (0.75 * 0.75))];
  const lobePos = [], lobeRad = [];
  // elongated, irregular cloud: lobes strung along a tilted main axis with sideways scatter
  const axis = new THREE.Vector3(1, 0.25 + r() * 0.3, (r() - 0.5) * 0.8).normalize();
  const side = new THREE.Vector3().crossVectors(axis, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(side, axis);
  for (let i = 1; i < N_LOBES; i++) {
    const u = ((i - 1) / (N_LOBES - 2)) * 2 - 1 + (r() - 0.5) * 0.25;
    const a = r() * Math.PI * 2, off = 0.25 + r() * 0.45;
    const d = axis.clone().multiplyScalar(u * 1.6).addScaledVector(side, Math.cos(a) * off).addScaledVector(up, Math.sin(a) * off * 0.7);
    const rad = (0.62 - Math.abs(u) * 0.2) * (0.8 + r() * 0.4);
    lobes.push(new THREE.Vector4(d.x, d.y, d.z, 1 / (rad * rad))); lobePos.push(d); lobeRad.push(rad);
  }
  // lights: central cluster + satellites embedded in lobes
  const lights = [new THREE.Vector4(0, 0, 0, 1.8)];
  const stars = [], starCol = [];
  const hot = new THREE.Color('#cfe4ff'), warm = new THREE.Color('#ffd9a8'), white = new THREE.Color('#fff4ea');
  for (let i = 0; i < 6; i++) {
    const d = randDir(r).multiplyScalar(i === 0 ? 0 : 0.07 + r() * 0.2);
    const big = i < 2;
    stars.push(new THREE.Vector4(d.x, d.y, d.z, big ? 0.028 - i * 0.006 : 0.007 + r() * 0.006));
    const c = (i % 3 === 2 ? white : hot).clone().multiplyScalar(big ? 2.2 : 1.2 + r() * 0.8);
    starCol.push(new THREE.Vector4(c.r, c.g, c.b, r() * 10));
  }
  for (let i = 1; i < N_LIGHTS; i++) {
    const base = lobePos[(i - 1) % lobePos.length].clone().multiplyScalar(0.55 + r() * 0.5);
    lights.push(new THREE.Vector4(base.x, base.y, base.z, 0.3 + r() * 0.3));
    const c = (r() < 0.6 ? warm : white).clone().multiplyScalar(1.4 + r());
    stars.push(new THREE.Vector4(base.x, base.y, base.z, 0.006 + r() * 0.008));
    starCol.push(new THREE.Vector4(c.r, c.g, c.b, r() * 10));
  }
  while (stars.length < N_STARS) {
    const d = randDir(r).multiplyScalar(0.4 + r() * 1.3);
    stars.push(new THREE.Vector4(d.x, d.y, d.z, 0.004 + r() * 0.004));
    const c = (r() < 0.5 ? warm : hot).clone().multiplyScalar(0.8 + r());
    starCol.push(new THREE.Vector4(c.r, c.g, c.b, r() * 10));
  }

  const lin = (h) => new THREE.Color(h);
  const vu = {
    uCam: { value: new THREE.Vector3() }, uRight: { value: new THREE.Vector3(1, 0, 0) }, uUp: { value: new THREE.Vector3(0, 1, 0) },
    uTime: { value: 0 }, uPix: { value: 0.001 }, uR: { value: R }, uSeed: { value: (o.seed * 3.17) % 50 }, uInt: { value: o.intensity },
    uGas: { value: o.gas }, uDust: { value: o.dust }, uDetail: { value: 1 },
    uLobes: { value: lobes }, uLights: { value: lights }, uStars: { value: stars }, uStarCol: { value: starCol },
    uColH: { value: lin(o.colorH) }, uColO: { value: lin(o.colorO) }, uColD: { value: lin(o.colorDust) }, uColV: { value: lin(o.colorShadow) },
  };
  const volMat = new THREE.ShaderMaterial({
    uniforms: vu, vertexShader: volVert, fragmentShader: volFrag, side: THREE.BackSide, transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  // The mesh only supplies one back-face fragment per covered pixel (the ray-sphere test uses uR), so a coarse sphere
  // scaled to circumscribe the true one (faces >= 0.9866 x vertex radius for 24x16) covers exactly the same pixels with
  // a quarter of the triangles (was 48x32).
  const vol = new THREE.Mesh(new THREE.SphereGeometry(R * 1.02, 24, 16), volMat);
  vol.renderOrder = 1;
  const tmpSize = new THREE.Vector2();
  vol.onBeforeRender = (renderer, scene, cam) => {
    renderer.getDrawingBufferSize(tmpSize);
    vu.uPix.value = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov || 50) / 2) / Math.max(tmpSize.y, 1);
  };
  group.add(vol);

  // points: wisps along the outskirts + faint embedded stars
  const NW = Math.round(5000 * o.wisps), NS = 550;
  const pos = new Float32Array((NW + NS) * 3), data = new Float32Array((NW + NS) * 4), colr = new Float32Array((NW + NS) * 3);
  const cH = lin(o.colorH), cO = lin(o.colorO), cV = lin(o.colorShadow);
  // filaments: random walks starting at the cloud edge, curling outward
  let k = 0;
  while (k < NW) {
    const li = Math.floor(r() * lobePos.length);
    const dir = lobePos[li].clone().normalize().add(randDir(r).multiplyScalar(0.7)).normalize();
    const p = lobePos[li].clone().addScaledVector(dir, lobeRad[li] * (0.6 + r() * 0.4));
    const v = dir.clone().add(randDir(r).multiplyScalar(0.8)).normalize();
    const len = 40 + Math.floor(r() * 60);
    const tint = r();
    for (let j = 0; j < len && k < NW; j++, k++) {
      v.add(randDir(r).multiplyScalar(0.06)).normalize();
      p.addScaledVector(v, 0.02);
      const jit = randDir(r).multiplyScalar(0.06 * r());
      pos.set([p.x + jit.x, p.y + jit.y, p.z + jit.z], k * 3);
      const fall = Math.max(0, 1 - j / len);
      data.set([0.12 + r() * 0.16, 0, r() * 10, 0.007 * fall * Math.sin(Math.PI * (j + 1) / (len + 1))], k * 4);
      const c = cH.clone().lerp(tint < 0.35 ? cO : cV, tint < 0.35 ? 0.7 : tint * 0.6);
      colr.set([c.r, c.g, c.b], k * 3);
    }
  }
  for (let i = 0; i < NS; i++, k++) {
    const d = randDir(r).multiplyScalar(Math.pow(r(), 0.7) * 2.2);
    pos.set([d.x, d.y, d.z], k * 3);
    data.set([0.012 + r() * 0.012, 1, r() * 3, 0.5 + r() * 1.2], k * 4);
    const c = (r() < 0.5 ? hot : warm);
    colr.set([c.r, c.g, c.b], k * 3);
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pg.setAttribute('aData', new THREE.BufferAttribute(data, 4));
  pg.setAttribute('aColor', new THREE.BufferAttribute(colr, 3));
  const pu = { uSeed: { value: (o.seed * 3.17) % 50 }, uTime: { value: 0 }, uScale: { value: 1 }, uPixH: { value: 600 } };
  const pts = new THREE.Points(pg, new THREE.ShaderMaterial({
    uniforms: pu, vertexShader: ptsVert, fragmentShader: ptsFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  pts.frustumCulled = false; pts.renderOrder = 2;
  pts.onBeforeRender = (renderer, scene, cam) => {
    renderer.getDrawingBufferSize(tmpSize);
    pu.uPixH.value = tmpSize.y / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov || 50) / 2));
    pu.uScale.value = vol.matrixWorld.getMaxScaleOnAxis();
  };
  group.add(pts);
  group.scale.setScalar(o.scale);

  const inv = new THREE.Matrix4(), q = new THREE.Quaternion(), camQ = new THREE.Quaternion();
  return {
    group, radius: R * 0.9 * o.scale,
    update(time, dt, camera) {
      const t = time * o.speed;
      vu.uTime.value = t; pu.uTime.value = t;
      group.updateMatrixWorld();
      inv.copy(vol.matrixWorld).invert();
      vu.uCam.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv);
      vol.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3());
      camera.getWorldQuaternion(camQ);
      q.invert().multiply(camQ);
      vu.uRight.value.set(1, 0, 0).applyQuaternion(q); vu.uUp.value.set(0, 1, 0).applyQuaternion(q);
      const d = vu.uCam.value.length();
      vu.uDetail.value = THREE.MathUtils.clamp((14 - d) / 6, 0, 1);
    },
  };
}
