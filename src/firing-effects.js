import * as THREE from 'three';
import './firing-effects.css';
import { createGlassImpact } from './glass-impact.js';

// The weapon flash is world-space; the pane has its own damage and fragment stages.
export function createFiringEffects({ scene, camera, stage, host, reducedMotion = false, captureBackground, onShot, onImpact, onShatter }) {
  const glass = createGlassImpact({ host, reducedMotion, captureBackground, onImpact, onShatter });
  const canvas = glass.canvas;
  const root = new THREE.Group();
  root.name = 'RX79G firing effects';
  root.visible = false;
  scene.add(root);

  const additive = color => new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false,
  });
  const haloMaterial = additive(0xff572b);
  const coreMaterial = additive(0xfff4cb);
  const boltMaterial = additive(0xffe7cb);
  const boltHaloMaterial = additive(0xff3827);
  const flareMaterial = additive(0xffcf8b);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), haloMaterial);
  const core = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), coreMaterial);
  const bolt = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 16), boltMaterial);
  const boltHalo = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 16), boltHaloMaterial);
  const flare = new THREE.Group();
  const petalGeometry = new THREE.ConeGeometry(1, 1, 3, 1, true);
  flareMaterial.side = THREE.DoubleSide;
  for (let i = 0; i < 6; i++) {
    const petal = new THREE.Mesh(petalGeometry, flareMaterial);
    const angle = i * Math.PI / 3;
    petal.rotation.z = angle - Math.PI / 2;
    petal.position.set(Math.cos(angle) * .11, Math.sin(angle) * .11, 0);
    petal.scale.set(.045, i % 2 ? .22 : .34, .02);
    flare.add(petal);
  }
  const muzzleLight = new THREE.PointLight(0xffb06c, 0, 3.4, 1.8);
  root.add(halo, core, bolt, boltHalo, flare, muzzleLight);

  const up = new THREE.Vector3(0, 1, 0);
  const muzzleWorld = new THREE.Vector3();
  const directionWorld = new THREE.Vector3(0, 0, 1);
  const shotDirection = new THREE.Vector3();
  const shotOrigin = new THREE.Vector3();
  const toCamera = new THREE.Vector3();
  const cameraForward = new THREE.Vector3();
  const impactTarget = new THREE.Vector3();
  const nearRay = new THREE.Vector3();
  const temp = new THREE.Vector3();
  const orientation = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  let binding = null;
  let elapsed = 0;
  let lastShot = -Infinity;
  let serial = 0;
  let burst = null;
  let pending = [];
  let disposed = false;
  const reduce = () => typeof reducedMotion === 'boolean' ? reducedMotion : reducedMotion.matches;

  function refreshWeapon() {
    if (!binding) return false;
    binding.bone.updateWorldMatrix(true, false);
    muzzleWorld.copy(binding.muzzleLocal).applyMatrix4(binding.bone.matrixWorld);
    directionWorld.copy(binding.forwardLocal).transformDirection(binding.bone.matrixWorld).normalize();
    return true;
  }

  function bindWeapon({ bone, muzzleLocal, forwardLocal }) {
    clear();
    binding = bone ? {
      bone,
      muzzleLocal: muzzleLocal?.isVector3 ? muzzleLocal.clone() : new THREE.Vector3(...(muzzleLocal || [0, 0, 0])),
      forwardLocal: (forwardLocal?.isVector3 ? forwardLocal.clone() : new THREE.Vector3(...(forwardLocal || [0, 0, 1]))).normalize(),
    } : null;
    refreshWeapon();
  }

  function fire({ aimAtCamera = true, screenImpact = true, impactUV } = {}) {
    if (disposed || !binding || elapsed - lastShot < .49 || !refreshWeapon()) return false;
    lastShot = elapsed;
    serial++;
    onShot?.({ index: serial });
    shotOrigin.copy(muzzleWorld);
    shotDirection.copy(directionWorld);
    toCamera.copy(camera.position).sub(muzzleWorld);
    if (aimAtCamera) shotDirection.copy(toCamera).normalize();
    let reach = Math.max(0, toCamera.length() - 1.7);
    if (screenImpact) {
      const rect = stage.getBoundingClientRect();
      const [u0, v0] = [[.39, .34], [.64, .47], [.49, .64]][(serial - 1) % 3];
      const u = impactUV?.x ?? u0;
      const v = impactUV?.y ?? v0;
      const width = window.innerWidth, height = window.innerHeight;
      const uv = {
        x: THREE.MathUtils.clamp((rect.left + rect.width * u) / width, .12, .88),
        y: THREE.MathUtils.clamp((rect.top + rect.height * v) / height, .14, .83),
      };
      if (aimAtCamera) {
        // End the tracer on the same screen-space point that the impact uses.
        // Its endpoint stays 1.7 world units in front of the camera, never inside it.
        const stageU = (uv.x * width - rect.left) / rect.width;
        const stageV = (uv.y * height - rect.top) / rect.height;
        camera.updateMatrixWorld();
        camera.getWorldDirection(cameraForward);
        nearRay.set(stageU * 2 - 1, 1 - stageV * 2, .5).unproject(camera).sub(camera.position).normalize();
        impactTarget.copy(camera.position).addScaledVector(nearRay, 1.7 / Math.max(.1, nearRay.dot(cameraForward)));
        shotDirection.copy(impactTarget).sub(shotOrigin);
        reach = shotDirection.length();
        shotDirection.normalize();
      }
      pending.push({ at: elapsed + (reduce() ? 0 : .13), uv, index: serial });
    }
    burst = { birth: elapsed, reach, reduce: reduce() };
    root.visible = !reduce();
    canvas.dataset.shots = String(serial);
    update(0);
    return true;
  }

  function update(delta = 0) {
    if (disposed) return;
    elapsed += Math.max(0, Math.min(delta, .1));
    if (pending.length) {
      const due = pending.filter(shot => elapsed >= shot.at);
      due.forEach(shot => glass.impact(shot, elapsed));
      pending = pending.filter(shot => elapsed < shot.at);
    }
    if (burst) {
      const age = elapsed - burst.birth;
      const flash = Math.max(0, 1 - age / .17);
      const visibleBolt = age > .018 && age < .15;
      refreshWeapon();
      halo.position.copy(muzzleWorld);
      core.position.copy(muzzleWorld);
      flare.position.copy(muzzleWorld);
      orientation.setFromUnitVectors(zAxis, shotDirection);
      halo.quaternion.copy(orientation);
      core.quaternion.copy(orientation);
      flare.quaternion.copy(camera.quaternion);
      halo.scale.set(.14 + .09 * flash, .14 + .09 * flash, .29 + .2 * flash);
      core.scale.set(.045 + .025 * flash, .045 + .025 * flash, .24 + .1 * flash);
      flare.scale.setScalar(.8 + .6 * (1 - flash));
      haloMaterial.opacity = flash * .38;
      coreMaterial.opacity = flash * .96;
      flareMaterial.opacity = flash * .75;
      muzzleLight.position.copy(muzzleWorld);
      muzzleLight.intensity = burst.reduce ? 0 : 7.5 * flash * flash;
      const travel = THREE.MathUtils.clamp(age / .15, 0, 1) * burst.reach;
      const length = Math.min(3.4, .7 + travel * .45, burst.reach * 1.8);
      // Keep the halo's leading edge outside the near-camera zone as well as its centre.
      const centreTravel = Math.min(travel, Math.max(0, burst.reach - length * 1.04 / 2));
      temp.copy(shotOrigin).addScaledVector(shotDirection, centreTravel);
      bolt.position.copy(temp);
      boltHalo.position.copy(temp);
      orientation.setFromUnitVectors(up, shotDirection);
      bolt.quaternion.copy(orientation);
      boltHalo.quaternion.copy(orientation);
      bolt.scale.set(.012, length, .012);
      boltHalo.scale.set(.028, length * 1.04, .028);
      boltMaterial.opacity = visibleBolt ? .95 : 0;
      boltHaloMaterial.opacity = visibleBolt ? .18 : 0;
      if (age > .22) { root.visible = false; muzzleLight.intensity = 0; burst = null; }
    }
    glass.update(elapsed);
  }

  function clear() {
    burst = null;
    pending = [];
    serial = 0;
    glass.clear();
    root.visible = false;
    muzzleLight.intensity = 0;
    lastShot = -Infinity;

  }

  function dispose() {
    clear();
    disposed = true;
    glass.dispose();
    root.removeFromParent();
    const geometries = new Set();
    const materials = new Set();
    root.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) materials.add(object.material);
    });
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
  }

  return {
    bindWeapon, fire, update, clear, dispose,
    get active() { return !!burst || pending.length > 0 || glass.active; },
    get shotCount() { return serial; },
    get state() { return glass.state; },
    get muzzleWorld() { refreshWeapon(); return muzzleWorld.clone(); },
    get directionWorld() { refreshWeapon(); return directionWorld.clone(); },
    get canvas() { return canvas; },
  };
}
