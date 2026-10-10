import './style.css';
import './stage.css';
import './chronicle.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createLightingRig } from './lighting-rig.js';
import { createGlassBackground } from './glass-background.js';
import { initHangarShader } from './hangar-shader.js';
import { createFiringEffects } from './firing-effects.js';
import { MUZZLE_ANCHOR } from './motion-config.js';
import { createRifleRecoil } from './rifle-recoil.js';
import { createCombatAudio } from './combat-audio.js';
import './motion.css';
import './refinement.css';

const $ = (s) => document.querySelector(s);
const stage = $('#scene');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const scene = new THREE.Scene();
const modelMount = new THREE.Group();
scene.add(modelMount);
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 150);
let renderer, controls, model, mixer, viewTween, activeClip = null;
let firingEffects, activeMotion = null, fireElapsed = null, nextShot = 0, shotView;
let rifleRecoil, recoilAmount = 0;
let lightingRig, glassBackground;
let motionRequest = 0;
const shotTimes = [0.72, 1.55, 2.38];
const firingDuration = 5.2;
const combatAudio = createCombatAudio({ onState(state) {
  const button = $('#combat-sound');
  button.textContent = state === 'error' ? '音效重试 ↻' : state === 'muted' ? '音效 / 关' : '音效 / 开';
  button.setAttribute('aria-pressed', String(state !== 'muted'));
  button.title = state === 'error' ? '录音素材未载入，点击重试' : '切换射击与玻璃音效';
} });
const motionDefinitions = [
  { id: 'original', label: '01 / 战术动作', clip: 'Combat sequence', duration: 7 },
  { id: 'shield', label: '02 / 举盾防御', clip: 'Shield Block - RX79G idle to block adaptation', duration: 0.57 },
  { id: 'fire', label: '03 / 举枪射击', clip: 'Firing Rifle - RX79G rifle and shield adaptation', duration: firingDuration },
];
let visible = true, ready = false, lastTime = 0, isWireframe = false;
const materialState = new Map();
const controlButtons = [...document.querySelectorAll('#controls button')];
controlButtons.forEach(b => b.disabled = true);
const initialPose = [];
const fullView = { position: [8.8, 4.5, 13.8], target: [0, 3.1, 0] };
const views = {
  full: fullView,
  head: { position: [2.8, 6.55, 4.8], target: [0.62, 5.75, -0.25] },
  back: { position: [-7.5, 4.8, -12.5], target: [0, 3.2, 0] },
};

function setRotation(value) {
  controls.autoRotate = value;
  $('#rotate').setAttribute('aria-pressed', String(value));
  $('#rotate-icon').textContent = value ? 'Ⅱ' : '↻';
  $('#rotate-label').textContent = value ? '停止旋转' : '自动旋转';
}

function fitCamera(name, instant = false, override) {
  const pose = override || (name === 'full' && activeClip
    ? { position: [9.8, 5.3, 16.5], target: [0, 3.8, 0] }
    : views[name]);
  document.querySelectorAll('[data-view]').forEach(b => {
    const active = b.dataset.view === name;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  setRotation(false);
  if (instant || reducedMotion.matches) {
    camera.position.fromArray(pose.position);
    controls.target.fromArray(pose.target);
    viewTween = null;
  } else {
    viewTween = { start: performance.now(), from: camera.position.clone(), to: new THREE.Vector3(...pose.position), targetFrom: controls.target.clone(), targetTo: new THREE.Vector3(...pose.target) };
  }
  controls.update();
}

function setMotionStatus(label, running = false) {
  $('#motion-state').textContent = label;
  $('#motion-state').classList.toggle('playing', running);
}

function clearFire(stop = true) {
  motionRequest++;
  combatAudio.stop();
  rifleRecoil?.restore();
  recoilAmount = 0;
  firingEffects?.clear();
  $('#clear-impact').hidden = true;
  fireElapsed = null;
  nextShot = 0;
  if (stop && activeMotion === 'fire' && activeClip) {
    activeClip.paused = true;
    setMotionStatus('射击停止 · 可重新播放');
  }
}

function restoreInitialPose() {
  initialPose.forEach(p => {
    p.obj.position.copy(p.position);
    p.obj.quaternion.copy(p.quaternion);
    p.obj.scale.copy(p.scale);
  });
  model.updateMatrixWorld(true);
}

function resize() {
  if (!renderer) return;
  const width = stage.clientWidth, height = stage.clientHeight;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function showError(error) {
  $('#loading').hidden = true;
  $('#load-error').hidden = false;
  $('#stage-status').textContent = '连接中断';
  $('#motion-buttons').textContent = '载入机体后可检视动作';
  console.error('Model load failed:', error);
}

try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  stage.prepend(renderer.domElement);
  renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    ready = false;
    clearFire();
    controlButtons.forEach(button => button.disabled = true);
    showError(new Error('WebGL context lost; reload to reconnect.'));
  });
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.065;
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.autoRotateSpeed = 0.65;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = Math.PI * 0.72;
  controls.addEventListener('start', () => { viewTween = null; setRotation(false); clearFire(); });
  lightingRig = createLightingRig({ scene, renderer });
  glassBackground = createGlassBackground({ host: $('#top'), stage, renderer });
  firingEffects = createFiringEffects({ scene, camera, stage, host: $('#top'), reducedMotion,
    captureBackground: () => glassBackground.capture(),
    onShot: event => combatAudio.play('shot', event),
    onImpact: event => combatAudio.play('impact', event),
    onShatter: event => {
      combatAudio.play('shatter', event);
      setMotionStatus('玻璃崩裂', true);
    },
  });
  resize(); fitCamera('full', true);
  new ResizeObserver(resize).observe(stage);
  new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (!visible) clearFire();
    lastTime = 0;
  }).observe(stage);

  const loader = new GLTFLoader();
  loader.load('/models/rx79g-tactical.glb', (gltf) => {
    model = gltf.scene;
    mixer = new THREE.AnimationMixer(model);
    const combatClip = gltf.animations.find(c => c.name === 'Combat sequence');
    if (combatClip) {
      const previewAction = mixer.clipAction(combatClip).play();
      mixer.setTime(1.75);
      previewAction.paused = true;
    }
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model, true);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = 6.6 / size.y;
    modelMount.scale.setScalar(scale);
    modelMount.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    modelMount.add(model);
    let meshCount = 0, boneCount = 0;
    model.traverse(obj => {
      initialPose.push({ obj, position: obj.position.clone(), quaternion: obj.quaternion.clone(), scale: obj.scale.clone() });
      if (obj.isBone) boneCount++;
      if (obj.isMesh) {
        meshCount++;
        obj.castShadow = true;
        obj.receiveShadow = true;
        obj.frustumCulled = false;
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach(m => { materialState.set(m, m.wireframe); });
      }
    });
    const playable = motionDefinitions.map(definition => {
      const clip = gltf.animations.find(candidate => candidate.name === definition.clip);
      if (!clip) throw new Error(`Missing required motion: ${definition.clip}`);
      return clip;
    });
    let rifleBone;
    model.traverse(object => {
      if (object.isBone && gltf.parser.associations.get(object)?.nodes === MUZZLE_ANCHOR.node) rifleBone = object;
    });
    if (!rifleBone) throw new Error('Rifle anchor is missing');
    firingEffects.bindWeapon({ bone: rifleBone, muzzleLocal: MUZZLE_ANCHOR.tip, forwardLocal: MUZZLE_ANCHOR.forward });
    rifleRecoil = createRifleRecoil({ model, rifleBone, forwardLocal: MUZZLE_ANCHOR.forward });
    // Frame the firing stance from the barrel side so its fire meets the viewer.
    mixer.stopAllAction();
    mixer.clipAction(playable[2]).reset().play();
    mixer.update(0);
    modelMount.updateMatrixWorld(true);
    const muzzle = new THREE.Vector3(...MUZZLE_ANCHOR.tip).applyMatrix4(rifleBone.matrixWorld);
    const direction = new THREE.Vector3(...MUZZLE_ANCHOR.forward).transformDirection(rifleBone.matrixWorld);
    const firingCamera = muzzle.clone().addScaledVector(direction, 16.8);
    firingCamera.y = THREE.MathUtils.clamp(firingCamera.y, 4.2, 7.2);
    shotView = { position: firingCamera.toArray(), target: [0, 3.45, 0] };
    mixer.stopAllAction();
    restoreInitialPose();
    const motionButtons = $('#motion-buttons');
    motionButtons.innerHTML = '';
    function updateMotionState(button) {
      motionButtons.querySelectorAll('button').forEach(b => {
        b.classList.toggle('is-active', b === button);
        b.setAttribute('aria-pressed', String(b === button));
      });
    }
    motionDefinitions.forEach((definition, index) => {
      const clip = playable[index];
      const button = document.createElement('button');
      button.textContent = definition.label;
      button.dataset.motion = definition.id;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', async () => {
        clearFire(false);
        const request = motionRequest;
        const audioReady = definition.id === 'fire' ? combatAudio.unlock() : null;
        mixer.stopAllAction();
        restoreInitialPose();
        activeMotion = definition.id;
        // A held source pose gives shield/aim transitions a clean start.
        const base = mixer.clipAction(combatClip).reset().play();
        base.time = 1.75;
        base.paused = true;
        activeClip = mixer.clipAction(clip).reset();
        activeClip.setLoop(definition.id === 'shield' ? THREE.LoopOnce : THREE.LoopRepeat, definition.id === 'shield' ? 1 : Infinity);
        activeClip.clampWhenFinished = true;
        activeClip.play();
        if (definition.id !== 'original') activeClip.crossFadeFrom(base, reducedMotion.matches ? 0.01 : 0.38, false);
        fitCamera('full', true, definition.id === 'fire' ? shotView : undefined);
        updateMotionState(button);
        setMotionStatus(definition.id === 'fire' ? '瞄准中' : `${definition.id === 'shield' ? '防御' : '战术动作'}演示中`, true);
        window.scrollTo({ top: 0, behavior: 'instant' });
        if (definition.id === 'fire') {
          await audioReady;
          if (request !== motionRequest) return;
          fireElapsed = 0;
          nextShot = 0;
        }
      });
      motionButtons.append(button);
    });
    const still = document.createElement('button');
    still.textContent = '静态检视'; still.className = 'is-active'; still.setAttribute('aria-pressed','true');
    still.dataset.motion = 'still';
    still.addEventListener('click', () => {
      clearFire(false); activeMotion = null;
      mixer.stopAllAction(); activeClip = null;
      restoreInitialPose();
      fitCamera('full');
      updateMotionState(still);
      setMotionStatus('STANDBY');
    });
    motionButtons.append(still);
    mixer.addEventListener('finished', event => {
      if (event.action === activeClip && activeMotion !== 'fire') setMotionStatus('动作完成 · 点击重播');
    });
    $('#loading').hidden = true;
    $('#stage-status').textContent = '实时 3D / 已接入';
    controlButtons.forEach(b => b.disabled = false);
    ready = true;
    window.__gundam = { ready, renderer, camera, controls, model, modelMount, mixer, clips: playable, firingEffects, combatAudio, lightingRig, glassBackground,
      get activeMotion() { return activeMotion; }, get fireElapsed() { return fireElapsed; },
      originalBounds: { min: box.min.toArray(), max: box.max.toArray() }, meshCount, boneCount };
  }, (event) => {
    const progress = event.total ? Math.min(99, Math.round(event.loaded / event.total * 100)) : 0;
    $('#load-number').textContent = String(progress).padStart(2,'0');
    $('#load-progress').style.width = `${progress}%`;
  }, showError);

  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { clearFire(); fitCamera(b.dataset.view); }));
  document.querySelectorAll('[data-inspect]').forEach(link => link.addEventListener('click', event => {
    if (!ready) return;
    event.preventDefault();
    if (link.dataset.inspect === 'shield') {
      document.querySelector('[data-motion="shield"]').click();
    } else {
      document.querySelector('[data-motion="still"]').click();
      // The static source pose keeps the rifle grip and shield struts intact.
      fitCamera('full', true, { position: [6.2, 4.0, 9.6], target: [-0.8, 2.9, 0] });
      window.scrollTo({ top: 0, behavior: 'instant' });
      setMotionStatus('步枪检视 · 拖动观察');
    }
    stage.focus({ preventScroll: true });
  }));
  $('#rotate').addEventListener('click', () => { clearFire(); viewTween=null; setRotation(!controls.autoRotate); });
  $('#clear-impact').addEventListener('click', () => clearFire());
  $('#combat-sound').addEventListener('click', async () => {
    if (combatAudio.state.error) await combatAudio.unlock();
    else {
      combatAudio.setMuted(!combatAudio.muted);
      if (!combatAudio.muted) await combatAudio.unlock();
    }
  });
  $('#wireframe').addEventListener('click', () => {
    isWireframe = !isWireframe;
    materialState.forEach((original, material) => { material.wireframe = isWireframe || original; });
    $('#wireframe').setAttribute('aria-pressed', String(isWireframe));
  });
  function zoom(factor) {
    clearFire();
    viewTween = null;
    const offset = camera.position.clone().sub(controls.target);
    const distance = THREE.MathUtils.clamp(offset.length()*factor, 2.3, 23);
    camera.position.copy(controls.target).add(offset.setLength(distance));
    controls.update();
  }
  $('#zoom-in').addEventListener('click', () => zoom(0.82));
  $('#zoom-out').addEventListener('click', () => zoom(1.22));
  $('#reset').addEventListener('click', () => { clearFire(); fitCamera('full'); });
  stage.addEventListener('keydown', event => {
    if (!ready) return;
    if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(0.9); }
    if (event.key === '-') { event.preventDefault(); zoom(1.1); }
    if (event.key === 'Home') { event.preventDefault(); clearFire(); fitCamera('full'); }
    if (event.key === 'Escape') clearFire();
  });
  reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) { setRotation(false); viewTween=null; clearFire(); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearFire(); lastTime = 0; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') clearFire(); });
  renderer.setAnimationLoop((time) => {
    const delta = lastTime ? Math.min((time-lastTime)/1000, 0.05) : 0;
    lastTime = time;
    if (!visible || document.hidden) return;
    if (viewTween) {
      const t = Math.min(1, (time - viewTween.start)/1000);
      const k = 1-Math.pow(1-t,3);
      camera.position.lerpVectors(viewTween.from, viewTween.to, k);
      controls.target.lerpVectors(viewTween.targetFrom, viewTween.targetTo, k);
      if (t === 1) viewTween = null;
    }
    if (activeClip) mixer.update(delta);
    controls.update(delta);
    modelMount.updateMatrixWorld(true);
    let fireNow = false;
    if (fireElapsed !== null) {
      fireElapsed += delta;
      if (nextShot < shotTimes.length && fireElapsed >= shotTimes[nextShot]) {
        fireNow = true;
        recoilAmount = 1;
        nextShot++;
        setMotionStatus(`开火 / ${String(nextShot).padStart(2, '0')}`, true);
      }
      // Hold the aiming pose while the last hit finishes breaking the pane.
      if (fireElapsed >= 2.72) activeClip.paused = true;
      if (fireElapsed >= firingDuration) {
        activeClip.paused = true;
        fireElapsed = null;
        setMotionStatus('射击完成 · 点击重播');
      }
    }
    rifleRecoil?.apply(reducedMotion.matches ? 0 : recoilAmount * 0.045);
    try {
      if (fireNow) firingEffects.fire({ aimAtCamera: true, screenImpact: true });
      firingEffects.update(delta);
      $('#clear-impact').hidden = !firingEffects.active;
      renderer.render(scene, camera);
      if (firingEffects.active) glassBackground.update();
    } finally {
      rifleRecoil?.restore();
    }
    recoilAmount *= Math.exp(-delta * 15);
    if (recoilAmount < 0.001) recoilAmount = 0;
  });
} catch(error) { showError(error); }

$('#retry').addEventListener('click', () => location.reload());
initHangarShader($('#dossier'), $('.hangar-image'));

const chapterTabs = [...document.querySelectorAll('.chapter-tabs [role="tab"]')];
function selectChapter(tab, focus = false) {
  chapterTabs.forEach(candidate => {
    const selected = candidate === tab;
    candidate.setAttribute('aria-selected', String(selected));
    candidate.tabIndex = selected ? 0 : -1;
    document.getElementById(candidate.getAttribute('aria-controls')).hidden = !selected;
  });
  if (focus) tab.focus();
}
chapterTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectChapter(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % chapterTabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + chapterTabs.length) % chapterTabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = chapterTabs.length - 1;
    if (next !== undefined) { event.preventDefault(); selectChapter(chapterTabs[next], true); }
  });
});
