// Camera rig: orbit around a focus point with inertia, plus eased "flights" between focus points.
import * as THREE from 'three';
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeIn = t => t * t * t;
const V = () => new THREE.Vector3();

export class Rig {
  constructor(camera) {
    this.camera = camera; this.T = V(); this.look = V();
    this.theta = 0.7; this.phi = 1.2; this.radius = 64; this.radiusGoal = 64; this.minR = 20; this.maxR = 120;
    this.vTheta = 0; this.vPhi = 0; this.auto = 0.02; this.dragging = false;
    this.flight = null; this.progress = 0; this.par = new THREE.Vector2(); this.parGoal = new THREE.Vector2();
    this.baseFov = camera.fov; this._p = V(); this._r = V(); this._u = V();
  }
  orbitPos(out) {
    const s = Math.sin(this.phi);
    return out.set(this.T.x + this.radius * s * Math.sin(this.theta), this.T.y + this.radius * Math.cos(this.phi), this.T.z + this.radius * s * Math.cos(this.theta));
  }
  snap(L, P) {
    this.T.copy(L); this.look.copy(L); const d = V().subVectors(P, L);
    this.radius = this.radiusGoal = d.length(); this.phi = Math.acos(THREE.MathUtils.clamp(d.y / this.radius, -1, 1)); this.theta = Math.atan2(d.x, d.z);
    this.vTheta = this.vPhi = 0; this.flight = null; this.camera.position.copy(P);
  }
  // Fly so the camera ends at P1 looking at L1. kind: 'arc' (travel) or 'dive' (plunge into a star).
  flyTo(L1, P1, dur, { kind = 'arc', onDone } = {}) {
    const P0 = this.camera.position.clone(), L0 = this.look.clone();
    const bulge = V().addVectors(P0, P1).multiplyScalar(0.5).sub(V().addVectors(L0, L1).multiplyScalar(0.5));
    const amt = kind === 'arc' ? Math.min(P0.distanceTo(P1) * 0.2, 16) : 0;
    if (bulge.lengthSq() > 1e-6) bulge.normalize().multiplyScalar(amt); else bulge.set(0, 0, 0);
    this.flight = { P0, L0, P1: P1.clone(), L1: L1.clone(), t: 0, dur, kind, bulge, onDone };
  }
  drag(dx, dy) { if (this.flight) return; this.vTheta = -dx * 0.0052; this.vPhi = -dy * 0.0052; }
  zoom(f) { if (this.flight) return; this.radiusGoal = THREE.MathUtils.clamp(this.radiusGoal * f, this.minR, this.maxR); }
  update(dt) {
    const cam = this.camera; let fovAdd = 0; this.progress = 0;
    if (this.flight) {
      const f = this.flight; f.t = Math.min(1, f.t + dt / f.dur);
      const e = f.kind === 'dive' ? easeIn(f.t) : ease(f.t);
      const el = f.kind === 'dive' ? ease(Math.min(1, f.t * 2)) : ease(Math.min(1, f.t * 1.45)); // the look-at leads: turn first, then travel
      this.look.lerpVectors(f.L0, f.L1, el);
      cam.position.lerpVectors(f.P0, f.P1, e).addScaledVector(f.bulge, Math.sin(Math.PI * e));
      this.progress = f.t; fovAdd = f.kind === 'dive' ? 34 * e : 9 * Math.sin(Math.PI * f.t);
      if (f.t >= 1) { const done = f.onDone; this.snap(f.L1, f.P1); if (done) done(); }
    } else {
      this.theta += this.vTheta + (this.dragging ? 0 : this.auto * dt); this.phi = THREE.MathUtils.clamp(this.phi + this.vPhi, 0.12, Math.PI - 0.12);
      const damp = Math.pow(this.dragging ? 0.0001 : 0.03, dt); this.vTheta *= damp; this.vPhi *= damp;
      this.radius += (this.radiusGoal - this.radius) * Math.min(1, dt * 6);
      this.orbitPos(cam.position); this.look.copy(this.T);
    }
    cam.up.set(0, 1, 0); cam.lookAt(this.look);
    // pointer parallax: a small sideways slide so near things move against far things
    this.par.lerp(this.parGoal, Math.min(1, dt * 2.5));
    const dist = cam.position.distanceTo(this.look);
    this._r.setFromMatrixColumn(cam.matrix, 0); this._u.setFromMatrixColumn(cam.matrix, 1);
    cam.position.addScaledVector(this._r, this.par.x * dist * 0.035).addScaledVector(this._u, this.par.y * dist * 0.035);
    cam.lookAt(this.look);
    const fov = this.baseFov + fovAdd; if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
  }
}
