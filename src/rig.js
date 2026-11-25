// Camera rig: orbit around a focus point with inertia, plus eased "flights" between focus points.
import * as THREE from 'three';
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeIn = t => t * t * t;
const V = () => new THREE.Vector3();

export class Rig {
  constructor(camera) {
    this.camera = camera; this.T = V(); this.look = V();
    this.theta = 0.7; this.phi = 1.2; this.radius = 64; this.radiusGoal = 64; this.minR = 20; this.maxR = 120;
    this.vTheta = 0; this.vPhi = 0; this.auto = 0.02; this.autoK = 1; this.dragging = false;
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
    this.vTheta = this.vPhi = 0; this.flight = null; this.autoK = 0; this.camera.position.copy(P);
  }
  // Fly so the camera ends at P1 looking at L1. kind: 'arc' (travel) or 'dive' (plunge into a star).
  flyTo(L1, P1, dur, { kind = 'arc', onDone } = {}) {
    const P0 = this.camera.position.clone(), L0 = this.look.clone();
    // Arc flights sweep sideways (away from the middle of the map) and rise a little, banking into the turn.
    const bulge = V(); let roll = 0;
    const dist = P0.distanceTo(P1);
    if (kind === 'arc' && dist > 1e-3) {
      const T = V().subVectors(P1, P0).normalize(), side = V().crossVectors(T, V().set(0, 1, 0));
      const amt = Math.min(dist * 0.25, 20);
      if (side.lengthSq() > 1e-4) {
        side.normalize(); const sign = side.dot(V().addVectors(P0, P1)) >= 0 ? 1 : -1;
        bulge.addScaledVector(side, sign * amt * 0.8); roll = sign * Math.min(0.11, dist * 0.004);
      }
      bulge.y += amt * 0.35;
    }
    const f = this.flight = { P0, L0, P1: P1.clone(), L1: L1.clone(), t: 0, dur, kind, bulge, roll, onDone };
    if (kind === 'spiral') { // intro: orbit down into the system around L1
      const d = V().subVectors(P1, L1); f.r1 = d.length(); f.th1 = Math.atan2(d.x, d.z); f.phi1 = Math.acos(THREE.MathUtils.clamp(d.y / f.r1, -1, 1));
    }
  }
  drag(dx, dy) { if (this.flight) return; this.vTheta = -dx * 0.0052; this.vPhi = -dy * 0.0052; }
  zoom(f) { if (this.flight) return; this.radiusGoal = THREE.MathUtils.clamp(this.radiusGoal * f, this.minR, this.maxR); }
  update(dt) {
    const cam = this.camera; let fovAdd = 0, rollNow = 0; this.progress = 0;
    if (this.flight) {
      const f = this.flight; f.t = Math.min(1, f.t + dt / f.dur);
      const t = f.t; let e, el;
      if (f.kind === 'dive') { e = t * t * (2.2 * t - 1.2); el = ease(Math.min(1, t * 2)); }           // ease-in-back: a small pull-back, then the plunge
      else if (f.kind === 'emerge') { e = 1 - Math.pow(1 - t, 3); el = 1; }                               // the dive played backwards: fast out, soft landing
      else if (f.kind === 'spiral') { e = 1 - Math.pow(1 - t, 4); el = 1; }
      else { e = ease(t); el = ease(Math.min(1, t * 1.45)); }                                               // the look-at leads: turn first, then travel
      this.look.lerpVectors(f.L0, f.L1, el);
      if (f.kind === 'spiral') {
        const th = f.th1 - 1.5 * (1 - e), r = f.r1 * Math.pow(4.2, 1 - e), ph = 0.95 + (f.phi1 - 0.95) * e;
        cam.position.set(f.L1.x + r * Math.sin(ph) * Math.sin(th), f.L1.y + r * Math.cos(ph), f.L1.z + r * Math.sin(ph) * Math.cos(th)); this.look.copy(f.L1);
      } else cam.position.lerpVectors(f.P0, f.P1, e).addScaledVector(f.bulge, Math.sin(Math.PI * e));
      this.progress = t; rollNow = f.roll * Math.sin(Math.PI * e);
      fovAdd = f.kind === 'dive' ? 34 * e : f.kind === 'emerge' ? 34 * Math.pow(1 - e, 2) : f.kind === 'spiral' ? 0 : 9 * Math.sin(Math.PI * t);
      if (f.t >= 1) { const done = f.onDone; this.snap(f.L1, f.P1); if (done) done(); }
    } else {
      this.autoK = Math.min(1, this.autoK + dt / 1.5); // ease into the idle orbit after a flight
      this.theta += this.vTheta + (this.dragging ? 0 : this.auto * this.autoK * dt); this.phi = THREE.MathUtils.clamp(this.phi + this.vPhi, 0.12, Math.PI - 0.12);
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
    cam.lookAt(this.look); if (rollNow) cam.rotateZ(rollNow);
    const fov = this.baseFov + fovAdd; if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
  }
}
