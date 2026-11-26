// Miniature planetary system ("Projects" hero): blue-white star, five shaded worlds on inclined Kepler orbits,
// moons, a ringed gas giant, an asteroid belt and comet-tail orbit trails.
// create({ seed, speed, starColor, starRadius, starIntensity, corona, spikes, orbitIntensity, trail, belt, light })
//   -> { group, radius, update(time, dt, camera) }
// Draw calls: star (3) + planets/moons (1, instanced) + atmosphere halos (1, instanced) + ring (1) + orbits (1) + belt (1).
import * as THREE from 'three';
import { NOISE } from '../glsl.js';
import { create as createStar, lodIndex } from './star.js';

const NB = 8; // bodies: 0 lava, 1 rocky, 2 ocean, 3 gas giant, 4 ice giant, 5-7 moons
const NP = 5; // planets (the ones with atmosphere halos)
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- shared GLSL
const COMMON = /* glsl */ `
uniform vec4 uBody[${NB}];   // xyz centre (group-local), w radius
uniform mat3 uRot[${NB}];    // object -> group-local rotation (tilt * spin)
uniform vec4 uKind[${NB}];   // x type, y seed, z atmosphere strength, w halo thickness
uniform vec3 uAtm[${NB}];    // atmosphere colour
uniform vec3 uCam;           // camera position in group-local space
uniform float uTime, uStarR, uLightK;
uniform vec3 uLight;
uniform int uRingId;
uniform vec2 uRingR;         // ring inner / outer radius in planet radii
float lightFall(vec3 P){ return uLightK*pow(2.4/max(length(P),0.5),0.55); }
// ring optical depth profile (r in planet radii) -> opacity 0..1
float ringD(float r){
  if(r<uRingR.x||r>uRingR.y) return 0.0;
  float x=(r-uRingR.x)/(uRingR.y-uRingR.x);
  float d=0.22;                                   // faint C ring
  d=mix(d,0.88,smoothstep(0.22,0.27,x));          // dense B ring
  d=mix(d,0.04,smoothstep(0.645,0.66,x));          // Cassini division
  d=mix(d,0.62,smoothstep(0.70,0.715,x));          // A ring
  d*=1.0-0.85*exp(-pow((x-0.905)*120.0,2.0));      // Encke gap
  d*=0.72+0.28*sin(r*61.0+sin(r*23.0)*2.0);
  d*=0.82+0.18*sin(r*173.0+sin(r*51.0)*3.0);
  d*=smoothstep(0.0,0.03,x)*smoothstep(1.0,0.96,x);
  return clamp(d,0.0,1.0);
}
// soft occlusion of the star (finite disc) by a sphere c (radius w) seen from P toward light L
float occl(vec3 P, vec3 L, vec4 c){
  vec3 tc=c.xyz-P; float t=dot(tc,L); if(t<=0.0) return 1.0;
  float d=length(tc-L*t);
  float pw=max(t*uStarR/length(P),0.002);          // penumbra half-width
  float cover=min(1.0,(c.w*c.w)/(pw*pw));
  return 1.0-cover*(1.0-smoothstep(c.w-pw,c.w+pw,d));
}
`;

// ---------------------------------------------------------------- planets
const planetVert = /* glsl */ `
${COMMON}
flat varying int vId; varying vec3 vObj; varying vec3 vPos;
void main(){
  vId=gl_InstanceID; vec4 b=uBody[vId];
  vObj=position; vec3 lp=b.xyz+uRot[vId]*(position*b.w); vPos=lp;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(lp,1.0);
}`;

const planetFrag = /* glsl */ `
${COMMON}
flat varying int vId; varying vec3 vObj; varying vec3 vPos;
${NOISE}
// crater field height (cell units scaled to sphere units)
float craterH(vec3 p, float freq, float seed, float dens){
  vec3 q=p*freq; vec3 ip=floor(q); vec3 fp=fract(q); float h=0.0;
  for(int z=-1;z<=1;z++) for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){
    vec3 o=vec3(float(x),float(y),float(z)); vec3 cell=ip+o+seed;
    if(hash31(cell+9.1)>dens) continue;
    vec3 fpnt=o+vec3(hash31(cell),hash31(cell+17.1),hash31(cell+31.7));
    float rad=0.18+0.32*pow(hash31(cell+5.3),2.0);
    float xx=length(fpnt-fp)/rad;
    if(xx<2.2){
      float bowl=xx<1.0?(xx*xx-1.0):0.0;
      float rim=exp(-(xx-1.0)*(xx-1.0)*16.0)*0.35;
      float ej=xx>1.0?0.12*exp(-(xx-1.0)*3.0):0.0;
      float peak=0.25*exp(-xx*xx*40.0)*step(0.35,rad);
      h+=(bowl*0.55+rim+ej+peak)*rad;
    }
  }
  return h/freq;
}
float rockH(vec3 p, float s){
  return craterH(p,2.6,s,0.55)*1.0+craterH(p,6.0,s+3.0,0.6)*0.8+craterH(p,13.0,s+7.0,0.65)*0.6+fbm3(p*6.0+s)*0.004;
}
vec3 rotY(vec3 p, float a){ float c=cos(a), s=sin(a); return vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z); }

void main(){
  int id=vId; vec4 b=uBody[id]; mat3 R=uRot[id]; vec4 k=uKind[id];
  float type=k.x, seed=k.y;
  vec3 p=normalize(vObj);
  vec3 N=normalize(vPos-b.xyz);
  vec3 L=normalize(-vPos);
  vec3 V=normalize(uCam-vPos);
  mat3 Rt=transpose(R);
  vec3 Lo=Rt*L;
  float NdL=dot(p,Lo);
  float mu=clamp(dot(N,V),0.0,1.0);
  float I=lightFall(vPos);

  // shadows: eclipses by other bodies, ring shadow
  float sh=1.0;
  for(int j=0;j<${NB};j++){ if(j==id) continue; sh*=occl(vPos,L,uBody[j]); }
  if(id==uRingId){
    vec3 po=Rt*(vPos-b.xyz)/b.w;
    if(abs(Lo.y)>1e-4){ float t=-po.y/Lo.y; if(t>0.0){ vec3 h=po+Lo*t; sh*=1.0-0.88*ringD(length(h.xz)); } }
  }

  vec3 alb=vec3(0.5); vec3 emis=vec3(0.0); float wrap=0.0; float spec=0.0; float rough=60.0;
  float lit=NdL;
  float limbDark=1.0;

  if(type<0.5){ // ---------------- lava world
    vec3 q=p*2.2+seed;
    vec3 w=q+vec3(fbm3(q*1.3),fbm3(q*1.3+5.2),fbm3(q*1.3+9.7))*0.45;
    float n=fbm(w*1.6);
    float cr=pow(1.0-abs(snoise(w*2.0)),10.0);
    float cr2=pow(1.0-abs(snoise(w*4.0+11.0)),26.0)*0.25*smoothstep(0.0,0.4,n+0.2);
    float pool=smoothstep(0.12,0.4,fbm3(q*0.7+vec3(5.0,0.0,uTime*0.01)));
    float crust=smoothstep(-0.1,0.5,snoise(w*9.0+uTime*0.02));
    float heat=clamp(max(cr+cr2,pool*mix(1.0,0.35,crust)),0.0,1.0);
    heat*=0.8+0.35*snoise(q*3.0+vec3(0.0,uTime*0.25,0.0));
    heat=clamp(heat,0.0,1.0);
    alb=mix(vec3(0.075,0.062,0.058),vec3(0.2,0.16,0.135),n*0.5+0.5)*(1.0-heat*0.6);
    vec3 hot=mix(vec3(0.9,0.1,0.015),vec3(1.0,0.55,0.16),smoothstep(0.4,1.0,heat));
    hot=mix(hot,vec3(1.0,0.85,0.55),smoothstep(0.85,1.0,heat));
    float night=smoothstep(0.25,-0.25,NdL*sh);
    emis=hot*heat*heat*mix(0.12,2.6,night);
    // dull red glow of the whole night hemisphere (heat haze)
    emis+=vec3(0.06,0.008,0.0)*night*(0.5+n);
    // relief from the crust
    float hh=n*0.02; vec3 Lt=Lo-p*NdL; float lt=length(Lt);
    if(lt>1e-4){ Lt/=lt; float h2=fbm(normalize(p+Lt*0.012)*2.2*1.6+seed*1.6+vec3(fbm3(q*1.3),fbm3(q*1.3+5.2),fbm3(q*1.3+9.7))*0.72)*0.02; lit=NdL-(h2-hh)/0.012*lt*0.9; }
    spec=0.1; rough=160.0;
  } else if(type<1.5||type>4.5){ // ---------------- rocky world / moon
    float moon=step(4.5,type);
    float H=rockH(p,seed);
    vec3 Lt=Lo-p*NdL; float lt=length(Lt);
    if(lt>1e-4){ Lt/=lt; float e=0.006; float H2=rockH(normalize(p+Lt*e),seed); lit=NdL-(H2-H)/e*lt*1.4; }
    float m=fbm3(p*1.7+seed+2.0);
    float mare=smoothstep(0.05,0.3,m);
    float fine=fbm(p*9.0+seed);
    vec3 a0=mix(vec3(0.50,0.34,0.22),vec3(0.5,0.48,0.46),moon);
    vec3 a1=mix(vec3(0.24,0.15,0.10),vec3(0.2,0.2,0.21),moon);
    alb=mix(a0,a1,mare)*(0.85+0.3*fine);
    alb=mix(alb,alb*vec3(1.15,0.95,0.8),smoothstep(0.2,0.6,snoise(p*2.0+seed+30.0))*(1.0-moon)*0.6);
    // bright ray/ejecta: fresh craters are lighter
    alb*=1.0+clamp(H*90.0,-0.25,0.35);
    // opposition-ish surge, harsh terminator
    spec=0.0;
  } else if(type<2.5){ // ---------------- ocean world
    vec3 q=p*1.6+seed;
    float c=fbm(q+fbm3(q*2.0)*0.35)-0.06;
    float land=smoothstep(0.02,0.06,c);
    float lat=abs(p.y);
    float dry=smoothstep(0.25,0.6,fbm3(q*2.3+4.0)*0.5+0.5-abs(lat-0.3));
    vec3 green=vec3(0.05,0.12,0.04), desert=vec3(0.33,0.25,0.15), rock=vec3(0.22,0.18,0.14);
    vec3 landC=mix(green,desert,dry); landC=mix(landC,rock,smoothstep(0.25,0.5,c));
    landC*=0.8+0.4*(fbm3(q*8.0)*0.5+0.5);
    vec3 sea=mix(vec3(0.012,0.05,0.13),vec3(0.02,0.14,0.22),smoothstep(-0.25,0.04,c));
    alb=mix(sea,landC,land);
    float ice=smoothstep(0.86,0.92,lat+fbm3(q*3.0)*0.08);
    alb=mix(alb,vec3(0.75,0.8,0.85),ice);
    // clouds: drift and swirl relative to the surface
    vec3 cp=rotY(p,uTime*0.035);
    vec3 cw=cp*2.4+seed+vec3(fbm3(cp*1.8+seed),fbm3(cp*1.8+seed+3.0),fbm3(cp*1.8+seed+6.0))*0.6;
    float cl=fbm(cw+vec3(uTime*0.01,0.0,0.0));
    float bandC=0.5+0.5*cos(p.y*7.5);
    float cloud=smoothstep(0.02,0.4,cl+0.12*bandC-0.05)*0.92;
    // cloud shadow: sample offset toward the light
    vec3 cps=normalize(cp+Lo*0.015);
    vec3 cws=cps*2.4+seed+vec3(fbm3(cps*1.8+seed),fbm3(cps*1.8+seed+3.0),fbm3(cps*1.8+seed+6.0))*0.6;
    float cloudS=smoothstep(0.02,0.4,fbm(cws+vec3(uTime*0.01,0.0,0.0))+0.12*bandC-0.05);
    alb*=1.0-0.55*cloudS*(1.0-cloud);
    spec=(1.0-land)*(1.0-ice)*(1.0-cloud); rough=600.0;
    alb=mix(alb,vec3(0.82,0.85,0.9),cloud);
    wrap=0.12;
  } else if(type<3.5){ // ---------------- banded gas giant with storm
    float lat=p.y;
    float diff=uTime*0.04*sin(lat*11.0+seed);
    vec3 dp=rotY(p,diff);
    vec3 sq=vec3(dp.x*2.2,dp.y*13.0,dp.z*2.2);
    float turb=fbm(sq+seed+vec3(uTime*0.015,0.0,0.0));
    float edge=fbm3(vec3(dp.x*5.0,dp.y*26.0,dp.z*5.0)+seed*2.0);
    float la=lat+turb*0.035+edge*0.012;
    // storm (oval vortex) at southern latitude
    vec3 sc=normalize(vec3(cos(seed+uTime*0.012),-0.38,sin(seed+uTime*0.012)));
    vec3 rel=dp-sc; vec3 sx=normalize(cross(vec3(0.0,1.0,0.0),sc)); vec3 sy=cross(sc,sx);
    vec2 sv=vec2(dot(rel,sx)/0.17,dot(rel,sy)/0.095); float sr=length(sv);
    float sw=exp(-sr*sr*1.2);
    float ang=sw*4.0+uTime*0.3*sw; float cs=cos(ang), sn=sin(ang);
    vec2 sv2=mat2(cs,-sn,sn,cs)*sv;
    la+=sw*0.03*sv2.y;
    float bands=sin(la*22.0+seed)*0.5+0.5;
    float bands2=sin(la*47.0+1.3*seed)*0.5+0.5;
    vec3 cream=vec3(0.78,0.70,0.56), tan=vec3(0.66,0.47,0.30), brown=vec3(0.40,0.26,0.17), white=vec3(0.82,0.80,0.74);
    vec3 cc=mix(tan,cream,smoothstep(0.3,0.7,bands));
    cc=mix(cc,brown,smoothstep(0.55,0.95,bands2)*(1.0-bands)*0.8);
    cc=mix(cc,white,smoothstep(0.75,1.0,bands)*0.5*(0.5+turb));
    cc*=0.85+0.25*(turb*0.5+0.5);
    cc=mix(cc,vec3(0.55,0.48,0.42),smoothstep(0.7,0.95,abs(lat))); // greyish poles
    // storm colouring
    float swirl=snoise(vec3(sv2*2.5,seed))*0.5+0.5;
    vec3 stormC=mix(vec3(0.62,0.26,0.13),vec3(0.82,0.5,0.32),swirl);
    cc=mix(cc,stormC,smoothstep(1.25,0.7,sr));
    cc=mix(cc,vec3(0.85,0.78,0.66),exp(-pow((sr-1.15)*4.0,2.0))*0.6);
    alb=cc*0.82;
    wrap=0.06; limbDark=pow(mu,0.25);
  } else { // ---------------- ice giant
    float lat=p.y;
    vec3 dp=rotY(p,uTime*0.03*sin(lat*6.0));
    float t=fbm3(vec3(dp.x*2.0,dp.y*9.0,dp.z*2.0)+seed);
    float bands=sin((lat+t*0.03)*15.0+seed)*0.5+0.5;
    vec3 c0=vec3(0.10,0.30,0.48), c1=vec3(0.22,0.48,0.60);
    alb=mix(c0,c1,bands*0.6+0.2*t);
    // dark spot + bright companion clouds
    vec3 sc=normalize(vec3(cos(seed*2.0),0.3,sin(seed*2.0)));
    vec3 rel=dp-sc; float sd=length(rel/vec3(0.22,0.11,0.22));
    alb=mix(alb,vec3(0.08,0.2,0.35),smoothstep(1.0,0.5,sd));
    float streak=smoothstep(0.55,0.9,fbm3(vec3(dp.x*2.5,dp.y*22.0,dp.z*2.5)+seed+3.0)*1.4)*smoothstep(0.5,0.2,abs(lat-0.42));
    alb=mix(alb,vec3(0.75,0.88,0.95),streak*0.45);
    alb=mix(alb,vec3(0.35,0.55,0.68),smoothstep(0.6,1.0,abs(lat))*0.5);
    wrap=0.1; limbDark=pow(mu,0.3);
  }

  float diffuse=clamp((lit+wrap)/(1.0+wrap),0.0,1.0);
  // soften the terminator a touch on atmosphere worlds
  diffuse*=smoothstep(-wrap-0.02,0.08,NdL);
  vec3 col=alb*diffuse*uLight*I*sh*limbDark*1.25;
  // atmospheric reddening near the terminator
  float term=exp(-pow((NdL-0.04)*8.0,2.0))*smoothstep(-0.12,0.04,NdL)*k.z*step(0.5,wrap*10.0);
  col+=alb*vec3(0.25,0.08,0.0)*term*sh*I*0.4;
  // specular glint (water / glassy lava)
  if(spec>0.0){ vec3 H=normalize(L+V); float nh=max(dot(N,H),0.0); float s=(pow(nh,rough)*1.4+pow(nh,rough*0.08)*0.06)*spec*smoothstep(0.0,0.1,NdL); col+=uLight*s*I*sh; }
  // atmosphere / fresnel rim inside the disc
  float rim=pow(1.0-mu,2.6);
  float dayRim=smoothstep(-0.35,0.55,dot(N,L));
  col+=uAtm[id]*rim*(0.03+dayRim*sh*0.85)*k.z*I;
  // faint ambient so night sides keep a silhouette
  col+=alb*0.0015+uAtm[id]*0.0012;
  col+=emis;
  gl_FragColor=vec4(col,1.0);
}`;

// ---------------------------------------------------------------- atmosphere halos (back faces of a larger sphere)
const haloVert = /* glsl */ `
${COMMON}
flat varying int vId; varying vec3 vPos;
void main(){
  vId=gl_InstanceID; vec4 b=uBody[vId];
  vec3 lp=b.xyz+uRot[vId]*(position*b.w*(1.0+uKind[vId].w)); vPos=lp;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(lp,1.0);
}`;
const haloFrag = /* glsl */ `
${COMMON}
flat varying int vId; varying vec3 vPos;
void main(){
  vec4 b=uBody[vId]; vec4 k=uKind[vId];
  vec3 D=normalize(vPos-uCam);
  float t=dot(b.xyz-uCam,D);
  vec3 Pc=uCam+D*t;
  float bb=length(Pc-b.xyz)/b.w;
  float x=(bb-1.0)/k.w; if(x>1.0||x<-0.05) discard;
  x=max(x,0.0);
  float glow=exp(-x*5.0)*(1.0-x)*(1.0-x);
  vec3 Lc=normalize(-b.xyz);
  vec3 nrm=normalize(Pc-b.xyz);
  float day=smoothstep(-0.4,0.6,dot(nrm,Lc));
  float fwd=pow(max(dot(D,Lc),0.0),6.0)*smoothstep(-0.5,0.2,dot(nrm,Lc)+0.3);
  float sh=1.0; for(int j=0;j<${NB};j++){ if(j==vId) continue; sh*=occl(Pc,normalize(-Pc),uBody[j]); }
  vec3 col=uAtm[vId]*glow*(day*0.55+fwd*1.4)*k.z*lightFall(b.xyz)*sh;
  if(k.x<0.5) col+=vec3(0.5,0.07,0.0)*glow*0.25*(1.0-day); // lava world: night-side heat haze
  gl_FragColor=vec4(col,1.0);
}`;

// ---------------------------------------------------------------- ring
const ringVert = /* glsl */ `
${COMMON}
varying vec2 vR; varying vec3 vPos;
void main(){
  int id=uRingId; vec4 b=uBody[id];
  vR=position.xy*uRingR.y;
  vec3 lp=b.xyz+uRot[id]*(vec3(position.x,0.0,position.y)*uRingR.y*b.w); vPos=lp;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(lp,1.0);
}`;
const ringFrag = /* glsl */ `
${COMMON}
varying vec2 vR; varying vec3 vPos;
${NOISE}
void main(){
  float r=length(vR);
  float d=ringD(r); if(d<0.004) discard;
  int id=uRingId; vec4 b=uBody[id]; mat3 R=uRot[id];
  vec3 n=R*vec3(0.0,1.0,0.0);
  vec3 L=normalize(-vPos); vec3 V=normalize(uCam-vPos);
  float mu0=dot(n,L), mu=dot(n,V);
  float I=lightFall(vPos);
  // planet shadow on the ring + moon shadows
  float sh=1.0; for(int j=0;j<${NB};j++) sh*=occl(vPos,L,uBody[j]);
  float ang=atan(vR.y,vR.x);
  float grain=0.9+0.1*snoise(vec3(r*40.0,ang*2.0,1.0));
  vec3 alb=mix(vec3(0.55,0.47,0.38),vec3(0.78,0.72,0.62),smoothstep(0.3,0.85,d))*grain;
  alb=mix(alb,vec3(0.45,0.42,0.40),smoothstep(0.5,0.2,(r-uRingR.x)/(uRingR.y-uRingR.x)+0.3)*0.5);
  vec3 col;
  if(mu0*mu>0.0){ // lit face seen
    float a0=abs(mu0), a1=abs(mu);
    col=alb*uLight*I*(2.0*a0/(a0+a1+0.05))*0.7;
  } else { // unlit face: diffuse transmission, strongest in thin parts, forward scattering
    float fwd=pow(max(dot(-V,L)*-1.0,0.0),1.0);
    float a0=abs(mu0);
    col=alb*uLight*I*a0*(1.0-d)*1.6*(0.4+1.2*pow(max(dot(V,-L),0.0),4.0));
  }
  col*=sh;
  float alpha=d*mix(1.0,0.75,1.0-abs(mu))*0.95;
  alpha=1.0-pow(1.0-d,1.0/max(abs(mu),0.08)*0.35+0.65); // thicker at grazing angles
  gl_FragColor=vec4(col,clamp(alpha,0.0,0.97));
}`;

// ---------------------------------------------------------------- orbit trails (screen-space ribbons)
const orbitVert = /* glsl */ `
attribute vec3 aTan; attribute float aSide; attribute float aPhase; attribute float aOrbit;
uniform float uOrbM[${NB}]; uniform vec3 uOrbC[${NB}]; uniform vec3 uOrbCol[${NB}]; uniform vec4 uOrbP[${NB}];
uniform float uViewH, uTrail, uOrbI;
varying float vSide; varying vec3 vCol;
void main(){
  int o=int(aOrbit+0.5);
  vec4 P=uOrbP[o]; // x base, y trail gain, z trail length k, w head width px
  vec3 lp=position+uOrbC[o];
  vec4 mv=modelViewMatrix*vec4(lp,1.0);
  vec3 tv=(modelViewMatrix*vec4(aTan,0.0)).xyz;
  vec3 sd=cross(tv,mv.xyz); float sl=length(sd); sd=sl>1e-6?sd/sl:vec3(0.0,1.0,0.0);
  float px=2.0*(-mv.z)/(projectionMatrix[1][1]*uViewH);
  float dl=fract(uOrbM[o]-aPhase);
  float tr=exp(-dl*P.z)*smoothstep(0.0,0.004,dl)*uTrail;
  float wpx=1.4+P.w*tr;
  mv.xyz+=sd*aSide*wpx*px*0.5;
  vSide=aSide;
  // keep total energy roughly constant with width
  float g=(P.x+P.y*tr*tr*0.6+P.y*tr*0.4)*uOrbI;
  vCol=uOrbCol[o]*g*(1.6/wpx+0.25);
  gl_Position=projectionMatrix*mv;
}`;
const orbitFrag = /* glsl */ `
varying float vSide; varying vec3 vCol;
void main(){ float a=1.0-vSide*vSide; gl_FragColor=vec4(vCol*a*a,1.0); }`;

// ---------------------------------------------------------------- asteroid belt
const beltVert = /* glsl */ `
attribute vec4 aOrb; attribute vec4 aMisc;
uniform float uTime, uViewH, uPeriodK, uLightK, uBelt; uniform vec3 uCam;
varying vec3 vCol; varying float vSoft;
vec3 rY(vec3 p,float a){ float c=cos(a), s=sin(a); return vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z); }
vec3 rX(vec3 p,float a){ float c=cos(a), s=sin(a); return vec3(p.x,c*p.y-s*p.z,s*p.y+c*p.z); }
void main(){
  float a=aOrb.x, e=aOrb.y;
  float M=aMisc.x+6.2831853/(uPeriodK*pow(a,1.5))*uTime;
  float E=M+e*sin(M); E=M+e*sin(E);
  vec3 o=vec3(a*(cos(E)-e),0.0,-a*sqrt(1.0-e*e)*sin(E));
  o=rY(o,aMisc.y); o=rX(o,aOrb.z); o=rY(o,aOrb.w);
  vec4 mv=modelViewMatrix*vec4(o,1.0);
  float px=aMisc.z*projectionMatrix[1][1]*uViewH*0.5/max(-mv.z,0.01);
  float dust=step(0.5,fract(aMisc.w*7.0)) ;
  gl_PointSize=clamp(px,1.0,dust>0.5?64.0:3.5);
  float cov=min(px*px,1.0); // sub-pixel grains fade instead of shimmering
  // crude phase lighting: brighter when the lit side faces the camera
  vec3 camL=uCam;
  float ph=0.35+0.65*(0.5+0.5*dot(normalize(-o),normalize(camL-o)));
  vec3 tint=mix(vec3(0.42,0.36,0.30),vec3(0.36,0.37,0.40),fract(aMisc.w*13.0));
  float I=uLightK*pow(2.4/length(o),0.55);
  float br=dust>0.5? 0.022*min(1.0,6.0/max(px,1.0)) : 0.55*cov;
  vCol=tint*ph*I*br*uBelt; vSoft=dust;
  gl_Position=projectionMatrix*mv;
}`;
const beltFrag = /* glsl */ `
varying vec3 vCol; varying float vSoft;
void main(){
  vec2 c=gl_PointCoord-0.5; float r2=dot(c,c)*4.0; if(r2>1.0) discard;
  float a=vSoft>0.5? (1.0-r2)*(1.0-r2) : smoothstep(1.0,0.3,r2);
  gl_FragColor=vec4(vCol*a,1.0);
}`;

// ---------------------------------------------------------------- helpers
function rng(seed) {
  let s = (Math.floor(seed * 9301 + 49297) >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function kepler(M, e) { let E = M; for (let i = 0; i < 6; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)); return E; }
function orbitBasis(inc, node, peri) {
  return new THREE.Matrix4().makeRotationY(node).multiply(new THREE.Matrix4().makeRotationX(inc)).multiply(new THREE.Matrix4().makeRotationY(peri));
}
function orbitPoint(a, e, E, out) { return out.set(a * (Math.cos(E) - e), 0, -a * Math.sqrt(1 - e * e) * Math.sin(E)); }

export function create(opts = {}) {
  const o = {
    seed: 1, speed: 1, starColor: '#bcd4ff', starRadius: 0.64, starIntensity: 1, corona: 0.7, spikes: 0.45,
    orbitIntensity: 1, trail: 1, belt: 1, light: 1, ...opts,
  };
  const rand = rng(o.seed);
  const group = new THREE.Group();
  const star = createStar({ color: o.starColor, radius: o.starRadius, intensity: o.starIntensity, corona: o.corona, spikes: o.spikes, seed: o.seed });
  group.add(star.group);

  const periodK = 16; // T = K a^1.5 seconds
  // planets: type, a, e, inc(deg), radius, atm colour, atm strength, halo thickness, tilt(deg), spin rate, orbit colour
  const P = [
    { type: 0, a: 1.6, e: 0.06, inc: 4, r: 0.12, atm: [1.0, 0.38, 0.12], as: 0.6, th: 0.16, tilt: 8, spin: 0.22, oc: [1.0, 0.45, 0.2] },
    { type: 1, a: 2.15, e: 0.08, inc: 7, r: 0.135, atm: [0.75, 0.68, 0.6], as: 0.35, th: 0.08, tilt: 15, spin: 0.15, oc: [0.85, 0.75, 0.62] },
    { type: 2, a: 2.75, e: 0.03, inc: 2, r: 0.17, atm: [0.3, 0.6, 1.0], as: 1.0, th: 0.2, tilt: 22, spin: 0.2, oc: [0.4, 0.68, 1.0] },
    { type: 3, a: 3.85, e: 0.045, inc: 5, r: 0.29, atm: [0.95, 0.78, 0.55], as: 0.7, th: 0.07, tilt: 24, spin: 0.32, oc: [1.0, 0.78, 0.5] },
    { type: 4, a: 4.6, e: 0.03, inc: 9, r: 0.2, atm: [0.45, 0.85, 1.0], as: 0.9, th: 0.12, tilt: 60, spin: 0.26, oc: [0.5, 0.9, 1.0] },
  ];
  for (const p of P) {
    p.node = rand() * TAU; p.peri = rand() * TAU; p.M0 = rand() * TAU; p.T = periodK * Math.pow(p.a, 1.5);
    p.basis = orbitBasis(p.inc * Math.PI / 180, p.node, p.peri);
    p.tiltM = new THREE.Matrix4().makeRotationY(rand() * TAU).multiply(new THREE.Matrix4().makeRotationZ(p.tilt * Math.PI / 180));
    p.spin0 = rand() * TAU;
  }
  // moons: parent, distance, period, radius, inclination to parent's equator
  const MO = [
    { parent: 2, d: 0.36, T: 7, r: 0.042, inc: 12 },
    { parent: 3, d: 0.74, T: 11, r: 0.05, inc: 2 },
    { parent: 3, d: 0.95, T: 17, r: 0.038, inc: 6 },
  ];
  for (const m of MO) {
    const par = P[m.parent];
    m.basis = new THREE.Matrix4().extractRotation(par.tiltM).multiply(orbitBasis(m.inc * Math.PI / 180, rand() * TAU, 0));
    m.M0 = rand() * TAU;
  }

  // ------------------------------------------------ shared uniforms
  const viewH = { value: 720 };
  const U = {
    uBody: { value: Array.from({ length: NB }, () => new THREE.Vector4()) },
    uRot: { value: Array.from({ length: NB }, () => new THREE.Matrix3()) },
    uKind: { value: Array.from({ length: NB }, () => new THREE.Vector4()) },
    uAtm: { value: Array.from({ length: NB }, () => new THREE.Vector3()) },
    uCam: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    uStarR: { value: o.starRadius },
    uLightK: { value: 1.0 * o.light },
    uLight: { value: new THREE.Vector3(0.93, 0.97, 1.06) },
    uRingId: { value: 3 },
    uRingR: { value: new THREE.Vector2(1.32, 2.25) },
  };
  P.forEach((p, i) => {
    U.uKind.value[i].set(p.type, o.seed * 3.7 + i * 11.3, p.as, p.th);
    U.uAtm.value[i].set(...p.atm);
  });
  MO.forEach((m, j) => { U.uKind.value[NP + j].set(5, o.seed * 5.1 + j * 7.7, 0.25, 0.05); U.uAtm.value[NP + j].set(0.6, 0.6, 0.62); });
  const setViewH = (renderer) => { viewH.value = renderer.getDrawingBufferSize(_v2).y; };
  const _v2 = new THREE.Vector2();

  // ------------------------------------------------ planets + moons (one instanced draw)
  // Tessellation follows the projected size of the biggest world (see update): at the default view the worlds are a
  // few dozen pixels across and a 96x64 sphere is mostly sub-pixel triangles (each shades a whole 2x2 pixel quad).
  // Levels keep the polygon outline within ~0.2 px of the circle; the full mesh is used close up.
  const inst = (w, h, n, r = 1) => { const g = new THREE.InstancedBufferGeometry().copy(new THREE.SphereGeometry(r, w, h)); g.instanceCount = n; return g; };
  const PLANET_LODS = [{ px: 25, g: inst(24, 16, NB) }, { px: 100, g: inst(48, 32, NB) }, { px: Infinity, g: inst(96, 64, NB) }];
  // halos are ray-analytic (the mesh only has to cover the halo radius): coarse levels circumscribe it
  const HALO_LODS = [{ px: 25, g: inst(24, 16, NP, 1.02) }, { px: Infinity, g: inst(48, 32, NP) }];
  let lodP, lodH;
  const pGeo = PLANET_LODS[2].g;
  const planets = new THREE.Mesh(pGeo, new THREE.ShaderMaterial({ uniforms: U, vertexShader: planetVert, fragmentShader: planetFrag }));
  planets.frustumCulled = false; planets.onBeforeRender = setViewH;
  group.add(planets);

  // ------------------------------------------------ atmosphere halos
  const hGeo = HALO_LODS[1].g;
  const halos = new THREE.Mesh(hGeo, new THREE.ShaderMaterial({
    uniforms: U, vertexShader: haloVert, fragmentShader: haloFrag, side: THREE.BackSide,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
  halos.frustumCulled = false; halos.renderOrder = 1;
  group.add(halos);

  // ------------------------------------------------ ring
  const ring = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: U, vertexShader: ringVert, fragmentShader: ringFrag, side: THREE.DoubleSide, transparent: true, depthWrite: false }));
  ring.frustumCulled = false; ring.renderOrder = 1;
  group.add(ring);

  // ------------------------------------------------ orbit ribbons
  const SEG = 360;
  const loops = [];
  P.forEach((p, i) => loops.push({ a: p.a, e: p.e, basis: p.basis, idx: i }));
  MO.forEach((m, j) => loops.push({ a: m.d, e: 0, basis: m.basis, idx: NP + j }));
  const pos = [], tan = [], side = [], phase = [], orb = [], index = [];
  const v = new THREE.Vector3(), v2 = new THREE.Vector3();
  let base = 0;
  for (const l of loops) {
    for (let s = 0; s <= SEG; s++) {
      const E = s / SEG * TAU;
      orbitPoint(l.a, l.e, E, v).applyMatrix4(l.basis);
      orbitPoint(l.a, l.e, E + 0.002, v2).applyMatrix4(l.basis).sub(v).normalize();
      const M = (E - l.e * Math.sin(E)) / TAU;
      for (const sd of [-1, 1]) { pos.push(v.x, v.y, v.z); tan.push(v2.x, v2.y, v2.z); side.push(sd); phase.push(M); orb.push(l.idx); }
      if (s < SEG) { const k = base + s * 2; index.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    base += (SEG + 1) * 2;
  }
  const oGeo = new THREE.BufferGeometry();
  oGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  oGeo.setAttribute('aTan', new THREE.Float32BufferAttribute(tan, 3));
  oGeo.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  oGeo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  oGeo.setAttribute('aOrbit', new THREE.Float32BufferAttribute(orb, 1));
  oGeo.setIndex(index);
  const OU = {
    uOrbM: { value: new Array(NB).fill(0) },
    uOrbC: { value: Array.from({ length: NB }, () => new THREE.Vector3()) },
    uOrbCol: { value: Array.from({ length: NB }, () => new THREE.Vector3()) },
    uOrbP: { value: Array.from({ length: NB }, () => new THREE.Vector4()) },
    uViewH: viewH, uTrail: { value: o.trail }, uOrbI: { value: o.orbitIntensity },
  };
  P.forEach((p, i) => { OU.uOrbCol.value[i].set(...p.oc); OU.uOrbP.value[i].set(0.07, 1.5, 4.5, 2.2); });
  MO.forEach((m, j) => { OU.uOrbCol.value[NP + j].set(0.8, 0.85, 0.95); OU.uOrbP.value[NP + j].set(0.03, 0.35, 4.0, 0.4); });
  const orbits = new THREE.Mesh(oGeo, new THREE.ShaderMaterial({
    uniforms: OU, vertexShader: orbitVert, fragmentShader: orbitFrag,
    blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  orbits.frustumCulled = false; orbits.renderOrder = 1; orbits.onBeforeRender = setViewH;
  group.add(orbits);

  // ------------------------------------------------ asteroid belt
  const NBELT = 9000;
  const aOrb = new Float32Array(NBELT * 4), aMisc = new Float32Array(NBELT * 4);
  for (let i = 0; i < NBELT; i++) {
    const dust = i % 4 === 0;
    // radial distribution: two overlapping families + Kirkwood-ish thinning
    let a = 3.08 + (rand() + rand() + rand() - 1.5) * 0.28;
    if (Math.abs(a - 3.2) < 0.025 && rand() < 0.7) a += 0.06;
    aOrb[i * 4] = a; aOrb[i * 4 + 1] = rand() * 0.06;
    aOrb[i * 4 + 2] = (rand() - 0.5) * 0.12 + 0.04; aOrb[i * 4 + 3] = rand() * TAU;
    aMisc[i * 4] = rand() * TAU; aMisc[i * 4 + 1] = rand() * TAU;
    aMisc[i * 4 + 2] = dust ? 0.06 + rand() * 0.1 : 0.0035 + Math.pow(rand(), 4) * 0.014;
    // aMisc.w encodes dust flag in fract(w*7)>=0.5 and tint in fract(w*13)
    let w;
    for (;;) { w = rand(); if ((((w * 7) % 1) >= 0.5) === dust) break; }
    aMisc[i * 4 + 3] = w;
  }
  const bGeo = new THREE.BufferGeometry();
  bGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NBELT * 3), 3));
  bGeo.setAttribute('aOrb', new THREE.BufferAttribute(aOrb, 4));
  bGeo.setAttribute('aMisc', new THREE.BufferAttribute(aMisc, 4));
  const belt = new THREE.Points(bGeo, new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uViewH: viewH, uPeriodK: { value: periodK }, uLightK: U.uLightK, uCam: U.uCam, uBelt: { value: o.belt } },
    vertexShader: beltVert, fragmentShader: beltFrag, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
  belt.frustumCulled = false; belt.renderOrder = 1; belt.onBeforeRender = setViewH;
  group.add(belt);

  // ------------------------------------------------ per-frame update
  const tmpM = new THREE.Matrix4(), tmpM2 = new THREE.Matrix4(), inv = new THREE.Matrix4(), cp = new THREE.Vector3();
  const centers = Array.from({ length: NB }, () => new THREE.Vector3());
  function update(time, dt, camera) {
    const t = time * o.speed;
    star.update(time, dt, camera);
    U.uTime.value = t;
    P.forEach((p, i) => {
      const M = p.M0 + TAU * t / p.T;
      orbitPoint(p.a, p.e, kepler(M, p.e), centers[i]).applyMatrix4(p.basis);
      U.uBody.value[i].set(centers[i].x, centers[i].y, centers[i].z, p.r);
      tmpM.copy(p.tiltM).multiply(tmpM2.makeRotationY(p.spin0 + t * p.spin));
      U.uRot.value[i].setFromMatrix4(tmpM);
      OU.uOrbM.value[i] = ((M / TAU) % 1 + 1) % 1;
    });
    MO.forEach((m, j) => {
      const i = NP + j, par = centers[m.parent];
      const M = m.M0 + TAU * t / m.T;
      orbitPoint(m.d, 0, M, centers[i]).applyMatrix4(m.basis).add(par);
      U.uBody.value[i].set(centers[i].x, centers[i].y, centers[i].z, m.r);
      // tidally locked: same face toward the parent
      tmpM.copy(m.basis).multiply(tmpM2.makeRotationY(M));
      U.uRot.value[i].setFromMatrix4(tmpM);
      OU.uOrbC.value[i].copy(par);
      OU.uOrbM.value[i] = ((M / TAU) % 1 + 1) % 1;
    });
    if (o.focus != null) group.position.copy(centers[o.focus]).negate(); // dev only: centre a body for close-ups
    if (camera) {
      group.updateWorldMatrix(true, false);
      inv.copy(group.matrixWorld).invert();
      U.uCam.value.copy(camera.getWorldPosition(cp)).applyMatrix4(inv);
      // nearest any world can be: the camera's distance to the centre less the outermost orbit (local units)
      const near = U.uCam.value.length() * group.matrixWorld.getMaxScaleOnAxis() - 4.8;
      const px = near > 0.3 ? 0.29 / near * viewH.value / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) : Infinity;
      const i = lodIndex(PLANET_LODS, px, lodP); if (i !== lodP) { lodP = i; planets.geometry = PLANET_LODS[i].g; }
      const j = lodIndex(HALO_LODS, px * 1.2, lodH); if (j !== lodH) { lodH = j; halos.geometry = HALO_LODS[j].g; }
    }
  }
  update(0, 0, null);

  return { group, radius: 5.2, update };
}
