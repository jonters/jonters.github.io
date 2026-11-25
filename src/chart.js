// Star-chart furniture: a faint polar grid through the origin and a stem from every node down to it,
// which is what makes depth readable when the graph is seen from the side.
import * as THREE from 'three';

export function createChart(nodes) {
  const group = new THREE.Group();
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(190, 190), new THREE.ShaderMaterial({
    uniforms: { uFade: { value: 1 } }, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    vertexShader: `varying vec2 vP; void main(){ vP=position.xy; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec2 vP; uniform float uFade;
      float line(float v,float w){ float d=abs(fract(v-0.5)-0.5)/max(fwidth(v),1e-5); return 1.0-smoothstep(w,w+1.0,d); }
      void main(){
        float r=length(vP); float a=atan(vP.y,vP.x);
        float rings=line(r/9.0,0.35);
        float major=line(r/27.0,0.6);
        float spokes=line(a*12.0/6.2831853,0.35)*smoothstep(4.0,9.0,r);
        // tick marks on the major rings
        float ticks=line(a*144.0/6.2831853,0.4)*smoothstep(0.55,0.0,abs(fract(r/27.0-0.5)-0.5)*27.0);
        float fade=smoothstep(92.0,30.0,r)*smoothstep(2.6,7.0,r);
        float I=(rings*0.026+major*0.042+spokes*0.016+ticks*0.045)*fade;
        gl_FragColor=vec4(vec3(0.55,0.68,1.0)*I*uFade,1.0);
      }` }));
  grid.rotation.x = -Math.PI / 2; grid.renderOrder = -5; group.add(grid);

  const pos = [], col = [], feet = [], feetCol = [];
  for (const n of nodes) {
    if (Math.abs(n.p.y) < 0.5) continue;
    const c = n.colorC;
    pos.push(n.p.x, n.p.y - Math.sign(n.p.y) * n.clear * 0.9, n.p.z, n.p.x, 0, n.p.z);
    col.push(c.r * 0.34, c.g * 0.34, c.b * 0.34, c.r * 0.07, c.g * 0.07, c.b * 0.07);
    feet.push(n.p.x, 0, n.p.z); feetCol.push(c.r, c.g, c.b);
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); lg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const stems = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
  group.add(stems);

  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.Float32BufferAttribute(feet, 3)); fg.setAttribute('color', new THREE.Float32BufferAttribute(feetCol, 3));
  const footMat = new THREE.ShaderMaterial({ uniforms: { uScale: { value: 800 } }, vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
    vertexShader: `uniform float uScale; varying vec3 vC; void main(){ vC=color; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mv; gl_PointSize=clamp(0.9*uScale/max(-mv.z,0.1),5.0,40.0); }`,
    fragmentShader: `varying vec3 vC; void main(){ float r=length(gl_PointCoord-0.5)*2.0; float ring=smoothstep(0.16,0.0,abs(r-0.72)); float dot_=smoothstep(0.22,0.08,r); gl_FragColor=vec4(vC*(ring*0.3+dot_*0.5),1.0); }` });
  group.add(new THREE.Points(fg, footMat));
  return { group, grid, update(pxScale) { footMat.uniforms.uScale.value = pxScale; } };
}
