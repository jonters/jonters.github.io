// Generic star: boiling photosphere + atmosphere shell + billboard corona with rays and diffraction spikes.
// create({ color, radius, intensity, speed, corona, spikes, seed }) -> { group, update(time, dt, camera), radius }
import * as THREE from 'three';
import { NOISE } from '../glsl.js';

const surfaceVert = /* glsl */ `
varying vec3 vObj; varying vec3 vNormalV; varying vec3 vViewDir;
void main(){ vObj=position; vec4 mv=modelViewMatrix*vec4(position,1.0); vNormalV=normalize(normalMatrix*normal); vViewDir=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`;

const surfaceFrag = /* glsl */ `
uniform float uTime,uIntensity,uSeed; uniform vec3 uColor; varying vec3 vObj; varying vec3 vNormalV; varying vec3 vViewDir;
${NOISE}
void main(){
  vec3 p=normalize(vObj)+uSeed;
  float t=uTime*0.12;
  // domain-warped convection cells
  vec3 w=p*2.2+vec3(fbm3(p*1.7+t),fbm3(p*1.7-t+4.0),fbm3(p*1.7+t*0.7+9.0))*0.55;
  float big=fbm(w+vec3(0.0,t*0.6,0.0));
  float gran=snoise(p*14.0+vec3(t*2.0,0.0,-t*1.5))*0.5+0.5;
  float fine=snoise(p*38.0-vec3(0.0,t*3.0,t))*0.5+0.5;
  float heat=0.5+0.5*big; heat=heat*0.72+gran*0.2+fine*0.08;
  float spots=smoothstep(0.52,0.78,fbm3(p*1.3-t*0.2+20.0)*0.5+0.5);
  heat*=1.0-spots*0.55;
  float mu=clamp(dot(normalize(vNormalV),normalize(vViewDir)),0.0,1.0);
  float limb=pow(mu,0.45);
  vec3 deep=uColor*uColor*0.35; vec3 hot=mix(uColor,vec3(1.0),0.72);
  vec3 col=mix(deep,uColor,smoothstep(0.15,0.55,heat)); col=mix(col,hot,smoothstep(0.5,0.95,heat));
  col*=(0.25+1.25*heat*heat)*mix(0.35,1.0,limb);
  col+=uColor*pow(1.0-mu,4.0)*0.9; // hot rim
  gl_FragColor=vec4(col*uIntensity*1.25,1.0);
}`;

const shellVert = /* glsl */ `
varying vec3 vObj; varying vec3 vNormalV; varying vec3 vViewDir;
void main(){ vObj=position; vec4 mv=modelViewMatrix*vec4(position,1.0); vNormalV=normalize(normalMatrix*normal); vViewDir=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`;
const shellFrag = /* glsl */ `
uniform float uTime,uIntensity,uSeed; uniform vec3 uColor; varying vec3 vObj; varying vec3 vNormalV; varying vec3 vViewDir;
${NOISE}
void main(){
  float mu=abs(dot(normalize(vNormalV),normalize(vViewDir)));
  // back faces of a larger sphere: mu->0 at the silhouette, grows toward the centre
  float a=pow(mu,2.2);
  float n=fbm3(normalize(vObj)*3.0+uSeed+vec3(0.0,uTime*0.25,0.0))*0.5+0.5;
  gl_FragColor=vec4(uColor*a*(0.4+n)*uIntensity*0.55,1.0);
}`;

const coronaVert = /* glsl */ `
uniform float uSize; varying vec2 vP;
void main(){ vP=position.xy; float s=length(modelMatrix[0].xyz); vec4 mv=modelViewMatrix*vec4(0.0,0.0,0.0,1.0); mv.xy+=position.xy*uSize*s; gl_Position=projectionMatrix*mv; }`;
const coronaFrag = /* glsl */ `
uniform float uTime,uIntensity,uSeed,uCorona,uSpikes,uCore; uniform vec3 uColor; varying vec2 vP;
${NOISE}
void main(){
  float r=length(vP); if(r>1.0) discard;
  float a=atan(vP.y,vP.x);
  float rc=uCore; // star radius in billboard units
  float d=max(r-rc,0.0)/(1.0-rc);
  // streamers: angular noise that drifts outward
  vec3 q=vec3(cos(a),sin(a),0.0);
  float rays=fbm3(q*2.6+vec3(0.0,0.0,d*1.6-uTime*0.07)+uSeed)*0.5+0.5;
  float fineRays=snoise(q*9.0+vec3(0.0,0.0,d*3.0-uTime*0.12)+uSeed*2.0)*0.5+0.5;
  float fall=exp(-d*7.0)*0.34+exp(-d*26.0)*0.85+0.012/(d*14.0+0.2);
  float streak=mix(0.3,1.7,rays*rays*1.6)*mix(0.75,1.25,fineRays);
  float glow=fall*streak*uCorona;
  // 4-point diffraction spikes
  vec2 ap=abs(vP); float sp=exp(-ap.y*90.0)*exp(-ap.x*3.2)+exp(-ap.x*90.0)*exp(-ap.y*3.2);
  vec2 dp=abs(mat2(0.7071,-0.7071,0.7071,0.7071)*vP); sp+=0.35*(exp(-dp.y*120.0)*exp(-dp.x*5.0)+exp(-dp.x*120.0)*exp(-dp.y*5.0));
  glow+=sp*uSpikes*0.5;
  float edge=smoothstep(1.0,0.55,r);
  vec3 col=mix(uColor,vec3(1.0),clamp(glow*0.22,0.0,0.75))*glow*edge;
  gl_FragColor=vec4(col*uIntensity,1.0);
}`;

// ---- level of detail for sphere meshes ----
// A 64x48 UV sphere is ~6k triangles. A few dozen pixels across, most of them are smaller than a pixel, and the GPU
// shades whole 2x2 pixel quads per triangle, so an expensive surface shader runs several times per covered pixel.
// Each level is used while the sphere's projected radius stays below `px`, chosen so the polygon outline stays within
// ~0.3 px of the true circle (radius * (1 - cos(pi / segments))). Shared unit spheres; meshes scale them.
const lodCache = new Map();
export function unitSphere(w, h) { const k = w + 'x' + h; if (!lodCache.has(k)) lodCache.set(k, new THREE.SphereGeometry(1, w, h)); return lodCache.get(k); }
export const SPHERE_LODS = [{ px: 14, w: 16, h: 12 }, { px: 60, w: 32, h: 24 }, { px: Infinity, w: 64, h: 48 }];
let viewH = 1080; // drawing-buffer height, refreshed whenever a star renders
const _wp = new THREE.Vector3(), _cp = new THREE.Vector3(), _vh = new THREE.Vector2();
export const noteViewH = renderer => { viewH = renderer.getDrawingBufferSize(_vh).y || viewH; };
// projected radius in pixels of a sphere of world radius r centred on obj's world position
export function projectedPx(obj, r, camera) {
  const d = _cp.setFromMatrixPosition(camera.matrixWorld).distanceTo(obj.getWorldPosition(_wp));
  return d <= r ? Infinity : r / Math.sqrt(d * d - r * r) * viewH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}
// index into `lods` for a projected radius, with 15% hysteresis so a sphere at a boundary does not flip every frame
export function lodIndex(lods, px, cur) {
  let i = 0; while (i < lods.length - 1 && px > lods[i].px) i++;
  if (cur !== undefined && i < cur && px > lods[i].px / 1.15) i = cur;
  return i;
}

export function create(opts = {}) {
  const o = { color: '#ffb061', radius: 1, intensity: 1, speed: 1, corona: 1, spikes: 0.5, seed: 1, ...opts };
  const group = new THREE.Group();
  const color = new THREE.Color(o.color);
  const u = () => ({ uTime: { value: 0 }, uIntensity: { value: o.intensity }, uSeed: { value: o.seed * 7.31 }, uColor: { value: color } });

  // surface and shell: unit spheres scaled to size (the shaders only use normalised positions and normals), with the
  // tessellation picked per frame from the projected size (see SPHERE_LODS); the full 64x48 mesh close up
  const surface = new THREE.Mesh(unitSphere(64, 48), new THREE.ShaderMaterial({ uniforms: u(), vertexShader: surfaceVert, fragmentShader: surfaceFrag }));
  surface.scale.setScalar(o.radius); surface.onBeforeRender = noteViewH;
  group.add(surface);

  const shell = new THREE.Mesh(unitSphere(48, 32), new THREE.ShaderMaterial({
    uniforms: u(), vertexShader: shellVert, fragmentShader: shellFrag, side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
  shell.scale.setScalar(o.radius * 1.22);
  group.add(shell);
  const SHELL_LODS = [SPHERE_LODS[0], SPHERE_LODS[1], { px: Infinity, w: 48, h: 32 }]; // its full detail was 48x32
  let lodS, lodH;

  const size = o.radius * 6.5;
  const corona = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { ...u(), uSize: { value: size }, uCorona: { value: o.corona }, uSpikes: { value: o.spikes }, uCore: { value: o.radius / size } },
    vertexShader: coronaVert, fragmentShader: coronaFrag, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
  corona.frustumCulled = false; corona.renderOrder = 2;
  group.add(corona);

  const mats = [surface.material, shell.material, corona.material];
  return {
    group, radius: o.radius, materials: mats,
    update(time, dt, camera) {
      for (const m of mats) m.uniforms.uTime.value = time * o.speed;
      if (camera) {
        const px = projectedPx(surface, o.radius, camera);
        const i = lodIndex(SPHERE_LODS, px, lodS); if (i !== lodS) { lodS = i; surface.geometry = unitSphere(SPHERE_LODS[i].w, SPHERE_LODS[i].h); }
        const j = lodIndex(SHELL_LODS, px * 1.22, lodH); if (j !== lodH) { lodH = j; shell.geometry = unitSphere(SHELL_LODS[j].w, SHELL_LODS[j].h); }
      }
    },
  };
}
