// Post-processing chain shared by the site and the dev harness, so bodies look the same in both.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null }, uTime: { value: 0 }, uAberration: { value: 0.0016 },
    uVignette: { value: 0.95 }, uGrain: { value: 0.035 }, uWarp: { value: 0 }, uFlash: { value: 0 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime,uAberration,uVignette,uGrain,uWarp,uFlash; varying vec2 vUv;
    float h(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
    void main(){
      vec2 c=vUv-0.5; float r2=dot(c,c);
      // uWarp: radial stretch used while diving into a star
      vec2 uv=0.5+c*(1.0-uWarp*0.55*r2*4.0);
      vec2 dir=c*(uAberration*(1.0+uWarp*14.0))*(0.35+r2*4.0);
      vec3 col;
      if(uWarp>0.001){
        col=vec3(0.0); float tot=0.0;
        for(int i=0;i<10;i++){ float f=float(i)/9.0; float w=1.0-f*0.6; vec2 u=0.5+(uv-0.5)*(1.0-uWarp*0.35*f);
          col+=w*vec3(texture2D(tDiffuse,u+dir).r,texture2D(tDiffuse,u).g,texture2D(tDiffuse,u-dir).b); tot+=w; }
        col/=tot;
      } else {
        col=vec3(texture2D(tDiffuse,uv+dir).r,texture2D(tDiffuse,uv).g,texture2D(tDiffuse,uv-dir).b);
      }
      col*=mix(1.0,smoothstep(0.95,0.18,sqrt(r2)),uVignette);
      col+=(h(vUv*vec2(1920.0,1080.0)+fract(uTime)*731.0)-0.5)*uGrain*(0.4+col.g);
      col+=uFlash;
      gl_FragColor=vec4(max(col,0.0),1.0);
    }`,
};

export function createPost(renderer, scene, camera) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 0 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.85, 0.75, 0.82);
  composer.addPass(bloom);
  const final = new ShaderPass(FinalShader);
  composer.addPass(final);
  composer.addPass(new OutputPass());
  return {
    composer, bloom, final,
    setSize(w, h) { composer.setSize(w, h); },
    render(time) { final.uniforms.uTime.value = time; composer.render(); },
  };
}

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x010208, 1);
  return renderer;
}
