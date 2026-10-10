import * as THREE from 'three';

/** Apply after the mixer, render/evaluate effects, then restore in finally. */
export function createRifleRecoil({ model, rifleBone, forwardLocal }) {
  // Names are verified against GLTFLoader's sanitized RX-79[G] bone names.
  const bicep = model.getObjectByName('BicepR');
  const hand = model.getObjectByName('HandR');
  if (!bicep?.isBone || !hand?.isBone || !rifleBone?.isBone) {
    return { apply: () => false, restore() {} };
  }

  const localForward = forwardLocal?.isVector3
    ? forwardLocal.clone().normalize()
    : new THREE.Vector3().fromArray(forwardLocal).normalize();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const axis = new THREE.Vector3();
  const savedBicep = new THREE.Quaternion();
  const savedGunPosition = new THREE.Vector3();
  const savedGunQuaternion = new THREE.Quaternion();
  const savedGunScale = new THREE.Vector3();
  const parentQuaternion = new THREE.Quaternion();
  const worldQuaternion = new THREE.Quaternion();
  const kickQuaternion = new THREE.Quaternion();
  const handBeforeInverse = new THREE.Matrix4();
  const gunBefore = new THREE.Matrix4();
  const gunAfter = new THREE.Matrix4();
  const parentInverse = new THREE.Matrix4();
  let applied = false;

  function restore() {
    if (!applied) return;
    bicep.quaternion.copy(savedBicep);
    rifleBone.position.copy(savedGunPosition);
    rifleBone.quaternion.copy(savedGunQuaternion);
    rifleBone.scale.copy(savedGunScale);
    bicep.updateWorldMatrix(true, true);
    rifleBone.updateWorldMatrix(true, true);
    applied = false;
  }

  function apply(amountRadians) {
    // Repeated calls in the same frame replace the kick instead of accumulating.
    restore();
    if (!Number.isFinite(amountRadians) || amountRadians === 0) return false;
    model.updateWorldMatrix(true, true);
    axis.copy(localForward).transformDirection(rifleBone.matrixWorld).cross(worldUp);
    if (axis.lengthSq() < 1e-10) return false;
    axis.normalize();

    savedBicep.copy(bicep.quaternion);
    savedGunPosition.copy(rifleBone.position);
    savedGunQuaternion.copy(rifleBone.quaternion);
    savedGunScale.copy(rifleBone.scale);
    handBeforeInverse.copy(hand.matrixWorld).invert();
    gunBefore.copy(rifleBone.matrixWorld);
    applied = true;

    bicep.getWorldQuaternion(worldQuaternion);
    bicep.parent.getWorldQuaternion(parentQuaternion).invert();
    kickQuaternion.setFromAxisAngle(axis, amountRadians);
    bicep.quaternion.copy(parentQuaternion.multiply(kickQuaternion).multiply(worldQuaternion)).normalize();
    bicep.updateWorldMatrix(true, true);

    // The rifle is an independent skin root. Move it by the hand's world delta
    // so the grip and the rifle's own child transforms stay unchanged.
    gunAfter.copy(hand.matrixWorld).multiply(handBeforeInverse).multiply(gunBefore);
    parentInverse.copy(rifleBone.parent.matrixWorld).invert();
    parentInverse.multiply(gunAfter).decompose(
      rifleBone.position, rifleBone.quaternion, rifleBone.scale,
    );
    rifleBone.updateWorldMatrix(true, true);
    return true;
  }

  return { apply, restore };
}
