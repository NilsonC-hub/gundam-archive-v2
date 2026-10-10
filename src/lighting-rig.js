import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/**
 * Light the normalized 6.6-unit figure as a sculptural object on the poster.
 * The renderer owns exposure; this rig only owns its lights, environment and floor.
 */
export function createLightingRig({ scene, renderer }) {
  const previousEnvironment = scene.environment;
  const previousEnvironmentIntensity = scene.environmentIntensity;
  const root = new THREE.Group();
  root.name = 'RX79G sculpting light rig';
  scene.add(root);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environmentTarget = pmrem.fromScene(room, 0.035);
  room.dispose();
  pmrem.dispose();
  const environment = { texture: environmentTarget.texture, intensity: 0.36 };
  scene.environment = environment.texture;
  scene.environmentIntensity = environment.intensity;

  function directional(name, color, intensity, position, target) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.name = name;
    light.position.fromArray(position);
    light.target.position.fromArray(target);
    root.add(light, light.target);
    return light;
  }

  // Broad front-left direction gives adjacent armor planes different values.
  const key = directional('Armor key', 0xfff3e3, 2.8, [-8, 11, 7], [0, 3, 0]);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, {
    left: -7, right: 7, top: 7, bottom: -7, near: 0.5, far: 35,
  });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.00015;
  key.shadow.normalBias = 0.012;

  // The rear edge separates the silhouette without bathing every front plane.
  const edge = directional('Cool edge', 0xdce8fa, 0.9, [6, 7, -6], [0, 3.6, 0]);
  // This source belongs to the back inspection view: it reveals the backpack
  // and dark joint faces instead of raising global exposure for the whole figure.
  const backFill = directional('Backpack fill', 0xe4ecf1, 1.3, [-6, 6.4, -9], [0, 3.8, 0]);
  const sky = new THREE.HemisphereLight(0xf0f5f8, 0x4d5558, 0.24);
  sky.name = 'Restrained room fill';
  root.add(sky);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(45, 45),
    new THREE.ShadowMaterial({ color: 0x263234, opacity: 0.15 }),
  );
  ground.name = 'Poster contact shadow';
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.03;
  ground.receiveShadow = true;
  root.add(ground);

  const lights = { key, edge, backFill, sky };
  const intensities = Object.fromEntries(Object.entries(lights).map(([name, light]) => [name, light.intensity]));
  const sourceNames = Object.freeze([...Object.keys(lights), 'environment']);
  let disposed = false;

  // Inspection hooks deliberately leave the camera, pose and exposure intact.
  function setSourceEnabled(name, enabled) {
    if (disposed) return;
    if (name === 'environment') {
      scene.environmentIntensity = enabled ? environment.intensity : 0;
      return;
    }
    if (!Object.hasOwn(lights, name)) throw new Error(`Unknown light source: ${name}`);
    lights[name].visible = Boolean(enabled);
  }

  function resetSources() {
    if (disposed) return;
    Object.entries(lights).forEach(([name, light]) => {
      light.visible = true;
      light.intensity = intensities[name];
    });
    scene.environmentIntensity = environment.intensity;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    root.removeFromParent();
    ground.geometry.dispose();
    ground.material.dispose();
    key.shadow.dispose();
    if (scene.environment === environment.texture) {
      scene.environment = previousEnvironment;
      scene.environmentIntensity = previousEnvironmentIntensity;
    }
    environmentTarget.dispose();
  }

  return { lights, environment, ground, sourceNames, setSourceEnabled, resetSources, dispose };
}
