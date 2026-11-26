// Black hole: ray-traced Schwarzschild lensing of a thin, sheared, Doppler-beamed accretion disk.
// create({ seed, intensity, spin, beaming, size, glow, jets, envGain }) -> also setEnvironment(cubeTexture) -> { group, radius, update(time, dt, camera) }
//
// One back-face sphere (radius uRb, in Schwarzschild radii) is the ray-tracing volume: every fragment marches the
// camera ray through it with x'' = -1.5 h^2 x / r^5 (exact photon orbits in Schwarzschild, affine parameter), picks up
// the disk slab wherever the bent ray crosses it (primary image, lensed far side over/under the shadow, higher orders),
// and writes premultiplied colour + alpha, so the shadow and the optically thick disk hide what is behind them while
// everything else stays additive. A small opaque disc behind the volume writes depth over the shadow so stars drawn
// later cannot show through the horizon.
import * as THREE from 'three';
import { NOISE } from '../glsl.js';

const traceVert = /* glsl */ `
varying vec3 vObj; varying vec3 vCam; varying vec4 vClip;
void main(){
  vObj=position;
  vCam=(inverse(modelMatrix)*vec4(cameraPosition,1.0)).xyz;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
  vClip=gl_Position;
}`;

const traceFrag = /* glsl */ `
uniform float uExpo,uTime,uRs,uRb,uRin,uRout,uSpin,uBeam,uIntensity,uSeed,uGlow,uHasEnv,uEnvGain;
uniform samplerCube uEnv; uniform mat3 uEnvRot;
varying vec3 vObj; varying vec3 vCam; varying vec4 vClip;
${NOISE}
const float BC=2.5980762; // critical impact parameter sqrt(27)/2 in units of Rs

// blackbody-ish ramp, t ~ 1 at the inner edge as seen at rest
vec3 bb(float t){
  vec3 c=vec3(0.35,0.02,0.005);
  c=mix(c,vec3(0.95,0.18,0.03),smoothstep(0.12,0.38,t));
  c=mix(c,vec3(1.0,0.48,0.12),smoothstep(0.32,0.62,t));
  c=mix(c,vec3(1.0,0.78,0.48),smoothstep(0.58,0.95,t));
  c=mix(c,vec3(1.0,0.95,0.9),smoothstep(0.9,1.25,t));
  c=mix(c,vec3(0.78,0.86,1.0),smoothstep(1.3,2.0,t));
  return c;
}

// value noise, periodic in x with integer period N (x runs around the disk)
float vn(vec2 x,float N,float o){
  vec2 i=floor(x); vec2 f=fract(x); vec2 u=f*f*f*(f*(f*6.0-15.0)+10.0);
  float i0=mod(i.x,N)+o, i1=mod(i.x+1.0,N)+o;
  float a=hash21(vec2(i0,i.y)), b=hash21(vec2(i1,i.y)), c=hash21(vec2(i0,i.y+1.0)), d=hash21(vec2(i1,i.y+1.0));
  return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
}
// one sheared layer: ang already includes -Omega(r)*t; long azimuthal filaments, warped radially
float layer(float r,float ang,float cyc,float lod){
  float u=ang*0.15915494;
  float o=uSeed*17.0+cyc*131.0;
  float n1=vn(vec2(u*9.0,r*0.7),9.0,o);
  float rw=r+(n1-0.5)*0.9;
  float n2=vn(vec2(u*26.0,rw*2.6),26.0,o+311.0);
  float d=0.35+1.0*n1*n2;
  if(lod>0.0){ // the two fine octaves are weighted by lod: when the hole is small on screen (lod = 0) skip them
    float n3=vn(vec2(u*70.0,rw*7.0+n2*0.8),70.0,o+733.0);
    float n4=vn(vec2(u*170.0,rw*17.0+n3*0.7),170.0,o+977.0);
    float f3=1.0-abs(2.0*n3-1.0); float f4=1.0-abs(2.0*n4-1.0);
    d+=0.45*lod*f3*f3; d+=0.25*lod*lod*f4*f4;
  }
  d*=0.7+0.6*n2;
  return d;
}

float diskDensity(float r,float phi,float lod){
  float om=uSpin*pow(r,-1.5);
  const float P=14.0;
  float tc=uTime/P; float fa=fract(tc), fb=fract(tc+0.5);
  float wa=1.0-abs(2.0*fa-1.0); float wb=1.0-wa;
  float da=layer(r,phi-om*fa*P,floor(tc),lod);
  float db=layer(r,phi-om*fb*P,floor(tc+0.5)+0.5,lod);
  float d=da*wa+db*wb;
  // restore the contrast lost by the cross-fade
  d=0.7+(d-0.7)/sqrt(wa*wa+wb*wb);
  d=max(d,0.0); return d*d*0.75;
}

float erfa(float x){ return tanh(1.2025*x); } // erf approximation, plenty for a glow integral

void main(){
  vec3 ro=vCam/uRs; vec3 rd=normalize(vObj/uRs-ro);
  vec3 Lm=cross(ro,rd); float b=length(Lm); float h2=b*b;
  float pw=max(fwidth(b),1e-4);
  if(b>uRout+0.3) discard; // misses the disk and the strong-field region: nothing to draw
  // entry into the bounding sphere
  float tb=dot(ro,rd); float c=dot(ro,ro)-uRb*uRb; float t0=0.0;
  if(c>0.0){ float disc=tb*tb-c; if(disc<=0.0||tb>0.0) discard; t0=-tb-sqrt(disc); }
  vec3 p=ro+rd*t0; vec3 v=rd;
  float lod=1.0-smoothstep(0.015,0.07,pw);
  int ns=0;
  float far=smoothstep(0.02,0.12,pw); // small on screen: denser, brighter disk so it still reads
  vec3 col=vec3(0.0); float T=1.0; float dens=0.7; bool capt=false;
  // disk angular momentum axis is -y (material moves along (-z,0,x))
  // dither the first step against slab banding, only for near-edge-on rays
  float jit=mix(1.0,hash21(gl_FragCoord.xy)*0.8+0.2,1.0-smoothstep(0.04,0.2,abs(rd.y)));
  for(int i=0;i<32;i++){
    float r2=dot(p,p); float r=sqrt(r2);
    if(r<1.0){ capt=true; break; }
    if(r>uRb+0.05 && dot(p,v)>0.0) break;
    float dt=max(0.07,0.17*r)*(0.6+0.4*smoothstep(1.2,4.0,abs(p.y)))*(i==0?jit:1.0);
    vec3 acc=-1.5*h2*p/(r2*r2*r);
    v+=acc*dt; vec3 pn=p+v*dt;
    float seg0=length(pn-p);
    float rm=length(0.5*(p.xz+pn.xz));
    float y0=p.y, y1=pn.y, dy=y1-y0;
    // optically thin hot corona hugging the disk: analytic integral of a gaussian in height along the segment
    {
      float Hg=0.12+0.03*rm;
      float G=abs(dy)>1e-3*Hg ? 0.886227*Hg*(erfa(y1/Hg)-erfa(y0/Hg))/dy : exp(-y0*y0/(Hg*Hg));
      G*=seg0;
      float rad=smoothstep(uRin*0.95,uRin*1.5,rm)*(1.0-smoothstep(uRout*0.35,uRout*1.08,rm));
      if(G*rad>1e-4){
        vec3 mp=0.5*(p+pn);
        vec3 tng=normalize(vec3(-mp.z,0.0,mp.x));
        float beta=min(sqrt(0.5/max(rm-1.0,0.5)),0.7);
        float g=inversesqrt(1.0-beta*beta)*(1.0+beta*dot(tng,normalize(v)));
        g=mix(1.0,sqrt(max(1.0-1.0/rm,0.05))/g,uBeam);
        float Tr=uRin/rm;
        col+=T*bb(Tr*g*0.9)*pow(Tr,1.8)*pow(g,2.0)*G*rad*uGlow*(1.0+1.2*far);
      }
    }
    // disk slab |y|<H: portion of this segment inside it
    float H=0.05+0.02*rm;
    float lo=0.0, hi=0.0;
    if(abs(dy)<1e-5){ if(abs(y0)<H){ lo=0.0; hi=1.0; } }
    else { float sa=(-H-y0)/dy, sb=(H-y0)/dy; lo=max(0.0,min(sa,sb)); hi=min(1.0,max(sa,sb)); }
    if(hi>lo){
      float sm=0.5*(lo+hi); vec3 q=mix(p,pn,sm);
      float r_=length(q.xz);
      float inner=smoothstep(uRin*0.78,uRin*1.12,r_);
      float outer=1.0-smoothstep(uRout*0.45,uRout,r_);
      float prof=exp(-2.0*q.y*q.y/(H*H));
      float seg=seg0*(hi-lo);
      if(inner*outer>0.001){
        float phi=atan(q.z,q.x);
        if(ns<6) dens=mix(diskDensity(r_,phi,lod),0.9,far*0.5); ns++;
        // relativistic Doppler + gravitational redshift
        vec3 dir=normalize(v);
        vec3 tng=normalize(vec3(-q.z,0.0,q.x));
        float beta=min(sqrt(0.5/max(r_-1.0,0.5)),0.7);
        float gam=inversesqrt(1.0-beta*beta);
        float g=1.0/(gam*(1.0+beta*dot(tng,dir)))*sqrt(max(1.0-1.0/r_,0.05));
        g=mix(1.0,g,uBeam);
        float Tr=uRin/r_;
        float Te=pow(Tr,1.3)*pow(g,0.8)*(0.74+0.2*dens);
        float I=pow(Tr,1.9)*pow(g,2.2)*(0.3+dens)*0.9;
        float tau=(0.35+dens)*inner*outer*prof*min(seg/(2.0*H),3.0)*1.9;
        float a=1.0-exp(-tau); float ab=1.0-exp(-tau*0.85);
        vec3 e=bb(Te)*I*inner*(0.3+0.7*outer)*(1.0+1.3*far);
        float el=dot(e,vec3(0.3,0.5,0.2)); e*=2.5/(2.5+el);
        col+=T*a*e; T*=1.0-ab;
        if(T<0.01) break;
      }
    }
    p=pn;
  }
  // photon ring: the stacked higher-order images, too thin for the step size; beamed like the disk
  float wr=0.018+pw*1.2;
  float ring=exp(-pow((b-BC)/wr,2.0))*(0.018/wr);
  float ringHalo=exp(-max(b-BC,0.0)*5.5)*step(BC-0.02,b)*0.10;
  float side=dot(normalize(Lm),vec3(0.0,1.0,0.0)); // photon L = -Lm; co-rotating (approaching) when -Lm || -y
  float rg=mix(1.0,1.0+0.55*side,uBeam);
  vec3 rc=bb(0.95*rg)*(ring*1.5+ringHalo)*rg;
  col+=T*sqrt(T)*rc; // the ring sits behind the disk: let a translucent near side dim it a little more
  float cap=smoothstep(BC+pw*0.75,BC-pw*0.75,b);
  // from outside the photon ring the analytic edge is exact (and anti-aliased); from inside it, outgoing rays with
  // b<BC escape, so trust the march instead
  float r0=length(ro);
  if(r0<BC*1.1){ float k=smoothstep(BC*0.95,BC*1.1,r0); cap=mix(capt?1.0:0.0,cap,k); }
  float alpha=1.0-T*(1.0-cap);
  col*=uIntensity*uExpo;
  // lensed backdrop: escaping rays see the sky along their bent exit direction. Replaces the real (unbent) sky in
  // a soft annulus around the shadow, fading to nothing well inside the tracing volume so there is no seam.
  float wEnv=uHasEnv*(1.0-smoothstep(1.25*BC,3.0*BC,b))*(1.0-cap)*T;
  if(wEnv>0.002 && !capt){
    vec3 vn=normalize(v); float r=length(p);
    // finish the bending analytically (weak field) from the last traced point out to infinity
    float s0=dot(p,vn); vec3 perp=p-s0*vn; float lp=length(perp);
    float dl=(1.0-s0*(2.0*s0*s0+3.0*h2)/(2.0*r*r*r))/max(b,1.0);
    if(lp>1e-4) vn=normalize(vn-perp/lp*dl);
    vec3 dW=normalize(uEnvRot*vn), uW=normalize(uEnvRot*rd);
    vec3 eB=textureCube(uEnv,dW).rgb, eU=textureCube(uEnv,uW).rgb;
    // where the exit direction swings faster than a pixel can resolve (hugging the ring), use the local sky tone
    float dd=length(fwidth(dW));
    eB=mix(eB,0.5*(eB+eU),smoothstep(0.01,0.06,dd))*(1.0-0.8*smoothstep(0.02,0.1,dd));
    // lensed stars, so the star density does not dip inside the annulus
    vec3 sp=dW*150.0; vec3 ci=floor(sp); float hs=hash31(ci+uSeed);
    if(hs>0.93){
      vec3 off=vec3(hash31(ci+3.1),hash31(ci+7.7),hash31(ci+11.3))-0.5;
      vec3 f=fract(sp)-0.5-off*0.4;
      float sw=max(dd*150.0*0.6,0.07);
      float st=exp(-dot(f,f)/(sw*sw))*(0.07/sw)*(0.07/sw)*(1.0-smoothstep(0.03,0.1,dd));
      eB+=st*mix(vec3(1.0,0.85,0.7),vec3(0.75,0.85,1.0),hash31(ci+5.0))*pow((hs-0.93)/0.07,3.0)*2.0;
    }
    float sy=clamp(0.5+0.5*vClip.y/vClip.w,0.0,1.0);
    float scr=mix(0.34,1.42,smoothstep(0.08,0.9,sy)); // the site's sky dims toward the bottom of the screen
    col+=wEnv*eB*scr*uEnvGain;
    alpha=1.0-(1.0-alpha)*(1.0-wEnv);
  }
  gl_FragColor=vec4(col,alpha);
}`;

const occVert = /* glsl */ `
uniform float uShadow,uRb; varying vec2 vP;
void main(){
  vP=position.xy;
  vec4 c=modelViewMatrix*vec4(0.0,0.0,0.0,1.0);
  float s=length(modelMatrix[0].xyz);
  float D=length(c.xyz); float rs=uShadow*s, rb=uRb*s;
  float sn=min(rs/max(D,1e-4),0.999); float L=D+rb;
  float size=L*sn/sqrt(1.0-sn*sn)*0.93*step(rs*1.15,D);
  // the disc faces the camera (perpendicular to the line of sight, not to the view axis): then every ray through it
  // meets it at distance >= L = D+rb, i.e. behind the tracing volume's back faces. Squared to the view axis it cut in
  // front of them whenever the hole was off-centre, the tracer failed the depth test there and whatever was drawn
  // before it (e.g. the sun's corona) showed as a bright wedge inside the shadow.
  vec3 w=c.xyz/max(D,1e-4); vec3 u=normalize(cross(w,abs(w.y)<0.99?vec3(0.0,1.0,0.0):vec3(1.0,0.0,0.0))); vec3 v=cross(u,w);
  c.xyz*=L/D; c.xyz+=(u*position.x+v*position.y)*size;
  gl_Position=projectionMatrix*c;
}`;
const occFrag = /* glsl */ `varying vec2 vP; void main(){ if(dot(vP,vP)>1.0) discard; gl_FragColor=vec4(0.0,0.0,0.0,1.0); }`;


// polar jets: an open cone per pole, glowing from the inside (soft at the silhouette), knots streaming outward
const jetVert = /* glsl */ `
varying float vS; varying float vA; varying float vF;
void main(){
  vS=uv.y; vA=uv.x;
  vec4 mv=modelViewMatrix*vec4(position,1.0);
  vec3 n=normalize(normalMatrix*normal);
  vF=abs(dot(n,normalize(-mv.xyz)));
  gl_Position=projectionMatrix*mv;
}`;
const jetFrag = /* glsl */ `
uniform float uTime,uJets,uSeed; varying float vS; varying float vA; varying float vF;
${NOISE}
void main(){
  float s=vS; // 0 at the base, 1 at the tip
  float a=vA*6.2831853;
  vec3 q=vec3(cos(a)*0.6,sin(a)*0.6,s*7.0-uTime*1.6+uSeed);
  float n=snoise(q)*0.5+0.5; float k=snoise(vec3(q.xy*0.4,s*16.0-uTime*3.2+uSeed*2.0))*0.5+0.5;
  float core=pow(vF,4.0);
  float fall=smoothstep(0.0,0.08,s)*pow(1.0-s,1.6)*exp(-s*1.8);
  float I=core*fall*(0.35+0.9*n*n+0.8*pow(k,4.0));
  vec3 c=mix(vec3(0.35,0.45,1.0),vec3(0.85,0.9,1.0),core*(1.0-s));
  gl_FragColor=vec4(c*I*uJets*0.22,1.0);
}`;

const _c = new THREE.Vector3(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
export function create(opts = {}) {
  const o = { seed: 1, intensity: 1, spin: 5.5, beaming: 1, size: 1, jets: 0, glow: 0.12, envGain: 1, ...opts };
  const group = new THREE.Group();
  const Rs = 0.34 * o.size;
  const Rb = 11.0; // tracing volume, in Rs
  // The tracing volume's mesh only has to produce one back-face fragment per covered pixel: the shader rebuilds the
  // camera ray from it and intersects the true sphere analytically. 24x16 (was 64x40) is inscribed to within 1.4%,
  // and rays beyond b = uRout+0.3 (97% of Rb) are discarded anyway, so the image is identical with ~7x fewer triangles,
  // which matters when the hole is small on screen (tiny triangles shade whole 2x2 quads each).
  const trace = new THREE.Mesh(new THREE.SphereGeometry(Rb * Rs, 24, 16), new THREE.ShaderMaterial({
    uniforms: {
      uExpo: { value: 1 }, uTime: { value: 0 }, uRs: { value: Rs }, uRb: { value: Rb }, uRin: { value: 3.0 }, uRout: { value: 10.4 },
      uSpin: { value: o.spin }, uBeam: { value: o.beaming }, uIntensity: { value: o.intensity },
      uSeed: { value: (o.seed * 7.31) % 50 }, uGlow: { value: o.glow },
      uEnv: { value: null }, uHasEnv: { value: 0 }, uEnvGain: { value: o.envGain }, uEnvRot: { value: new THREE.Matrix3() },
    },
    vertexShader: traceVert, fragmentShader: traceFrag, side: THREE.BackSide, transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  }));
  trace.renderOrder = 3;
  group.add(trace);

  const occ = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { uShadow: { value: 2.598 * Rs }, uRb: { value: Rb * Rs } }, vertexShader: occVert, fragmentShader: occFrag }));
  occ.frustumCulled = false;
  group.add(occ);

  const jetMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uJets: { value: o.jets }, uSeed: { value: (o.seed * 3.17) % 40 } },
    vertexShader: jetVert, fragmentShader: jetFrag, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
  const jetLen = 5.2 * o.size;
  const jetGeo = new THREE.CylinderGeometry(0.5 * o.size, 0.04 * o.size, jetLen, 32, 1, true);
  jetGeo.translate(0, jetLen / 2 + 0.25 * o.size, 0);
  for (const sgn of [1, -1]) {
    if (!(o.jets > 0)) break;
    const j = new THREE.Mesh(jetGeo, jetMat);
    j.scale.y = sgn; j.renderOrder = 1; // drawn before the tracer so the shadow hides the far jet's base
    group.add(j);
  }

  return {
    group, radius: Rb * Rs * 0.95,
    update(time, dt, camera) {
      const u = trace.material.uniforms;
      u.uTime.value = time; jetMat.uniforms.uTime.value = time;
      if (camera) { // gentle exposure adaptation: close up the disk fills the screen and the bloom would wash the shadow
        group.getWorldPosition(_c); const s = group.getWorldScale(_s).x;
        const d = _p.setFromMatrixPosition(camera.matrixWorld).distanceTo(_c) / (s * o.size);
        u.uExpo.value = 0.5 + 0.5 * THREE.MathUtils.smoothstep(d, 2.0, 9.0);
      }
      if (u.uHasEnv.value) {
        group.updateWorldMatrix(true, false);
        const e = group.matrixWorld.elements; // rotation part, scale removed
        const sx = Math.hypot(e[0], e[1], e[2]), sy = Math.hypot(e[4], e[5], e[6]), sz = Math.hypot(e[8], e[9], e[10]);
        u.uEnvRot.value.set(e[0] / sx, e[4] / sy, e[8] / sz, e[1] / sx, e[5] / sy, e[9] / sz, e[2] / sx, e[6] / sy, e[10] / sz);
      }
    },
    // the site's baked sky cubemap (world-space directions): enables the lensed-backdrop term near the hole
    setEnvironment(tex) {
      const u = trace.material.uniforms;
      u.uEnv.value = tex || null; u.uHasEnv.value = tex ? 1 : 0;
    },
  };
}
