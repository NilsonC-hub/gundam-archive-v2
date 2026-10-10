import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// A separate transparent renderer lets the glass cross both the DOM poster and
// the model. Its transmission lookup follows screen position, not the shard's
// original UV: a piece bends whatever is currently behind it as it moves.
const vertexShader = `
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec2 vDamageUv;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vDamageUv = uv;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = `
  uniform sampler2D uBackground;
  uniform sampler2D uDamage;
  uniform samplerCube uEnvironment;
  uniform vec2 uResolution;
  uniform vec2 uViewport;
  uniform float uOpacity;
  uniform float uHasBackground;
  uniform float uSide;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec2 vDamageUv;

  void main() {
    vec3 incident = normalize(vWorldPosition - cameraPosition);
    vec3 normal = normalize(vWorldNormal);
    if (dot(normal, incident) > 0.0) normal = -normal;
    float facing = max(0.001, dot(-incident, normal));
    float fresnel = 0.040 + 0.960 * pow(1.0 - facing, 5.0);
    vec3 through = refract(incident, normal, 1.0 / 1.52);

    // Thin glass produces a small lateral shift, growing toward grazing view.
    // Chromatic dispersion stays sub-pixel at normal incidence.
    float thickness = mix(2.6, 7.0, uSide);
    float path = thickness / max(0.18, facing);
    vec2 bend = (through.xy / max(0.22, abs(through.z))
      - incident.xy / max(0.22, abs(incident.z))) * path;
    bend = clamp(bend, vec2(-21.0), vec2(21.0));
    vec2 screenUv = gl_FragCoord.xy / uResolution;
    vec2 shift = bend / uViewport;
    vec2 sampleUv = clamp(screenUv + shift, vec2(0.001), vec2(0.999));
    vec3 transmitted;
    transmitted.r = texture2D(uBackground, clamp(sampleUv + shift * 0.013, 0.001, 0.999)).r;
    transmitted.g = texture2D(uBackground, sampleUv).g;
    transmitted.b = texture2D(uBackground, clamp(sampleUv - shift * 0.018, 0.001, 0.999)).b;
    // Almost colourless faces; the longer optical path at a cut edge carries
    // the slight bottle-green tint. There is no opaque silver face coating.
    transmitted *= exp(-vec3(0.0025, 0.00065, 0.0013) * path);

    vec3 reflected = reflect(incident, normal);
    // This is the same RoomEnvironment family used by the model, captured as
    // a small cube map. Reflections therefore rotate with a real surface normal.
    vec3 environment = textureCube(uEnvironment, reflected).rgb;
    environment = environment / (vec3(1.0) + environment * 0.24);
    float reflectionWeight = min(0.86, fresnel);
    vec3 colour = mix(transmitted, environment * 0.72, reflectionWeight);
    vec4 damage = texture2D(uDamage, vDamageUv);
    colour = mix(colour, damage.rgb, damage.a * (1.0 - uSide) * 0.86);

    // If the optional DOM capture fails, only actual glints and the edge remain.
    // Do not cover the page with a substitute grey pane.
    float coverage = mix(min(0.42, fresnel * 0.5 + uSide * 0.10), 0.97, uHasBackground);
    if (uHasBackground < 0.5) colour = environment * 0.72;
    gl_FragColor = vec4(colour, coverage * uOpacity);
    #include <colorspace_fragment>
  }
`;

function makeGeometry(cell, width, height) {
  const contour = cell.poly.map(p => new THREE.Vector2(p.x - cell.center.x, cell.center.y - p.y));
  const triangles = THREE.ShapeUtils.triangulateShape(contour, []);
  const positions = [], normals = [], uvs = [];
  for (const triangle of triangles) {
    for (const index of triangle) {
      const p = contour[index], source = cell.poly[index];
      positions.push(p.x, p.y, 0);
      normals.push(0, 0, 1);
      uvs.push(source.x / width, 1 - source.y / height);
    }
  }
  const front = new THREE.BufferGeometry();
  front.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  front.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  front.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));

  const sidePositions = [], sideNormals = [], sideUvs = [];
  const thickness = 1.35;
  for (let i = 0; i < contour.length; i++) {
    const j = (i + 1) % contour.length, a = contour[i], b = contour[j];
    const n = new THREE.Vector3(b.y - a.y, a.x - b.x, 0).normalize();
    const vertices = [
      [a.x, a.y, 0], [b.x, b.y, 0], [b.x, b.y, -thickness],
      [a.x, a.y, 0], [b.x, b.y, -thickness], [a.x, a.y, -thickness],
    ];
    vertices.forEach(p => {
      sidePositions.push(...p); sideNormals.push(n.x, n.y, 0);
      sideUvs.push((p[0] + cell.center.x) / width, (p[1] - cell.center.y) / height + 1);
    });
  }
  const sides = new THREE.BufferGeometry();
  sides.setAttribute('position', new THREE.Float32BufferAttribute(sidePositions, 3));
  sides.setAttribute('normal', new THREE.Float32BufferAttribute(sideNormals, 3));
  sides.setAttribute('uv', new THREE.Float32BufferAttribute(sideUvs, 2));
  return { front, sides };
}

export function createGlassRefraction() {
  const canvas = document.createElement('canvas');
  canvas.className = 'viewer-impact glass-refraction';
  canvas.dataset.effect = 'refractive-glass-fragments';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.zIndex = '59';
  document.body.append(canvas);
  let renderer, scene, camera, environment, room;
  let frontMaterial, sideMaterial, backgroundTexture, damageTexture;
  let fragments = [], width = 1, height = 1, dpr = 1;
  let failed = false, frameVisible = false, backgroundSource = null;
  let backgroundReady = false;
  let backgroundSize = '', damageSize = '';
  const empty = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
  empty.needsUpdate = true;

  function initialize() {
    if (renderer || failed) return !!renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.setClearColor(0x000000, 0);
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(45, 1, 1, 1800);
      environment = new THREE.WebGLCubeRenderTarget(128, {
        type: THREE.HalfFloatType,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
      });
      room = new RoomEnvironment();
      new THREE.CubeCamera(0.1, 100, environment).update(renderer, room);
      const uniforms = {
        uBackground: { value: empty }, uDamage: { value: empty },
        uEnvironment: { value: environment.texture },
        uResolution: { value: new THREE.Vector2() },
        uViewport: { value: new THREE.Vector2() },
        uOpacity: { value: 1 }, uHasBackground: { value: 0 }, uSide: { value: 0 },
      };
      frontMaterial = new THREE.ShaderMaterial({
        uniforms, vertexShader, fragmentShader, transparent: true,
        depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      });
      sideMaterial = new THREE.ShaderMaterial({
        uniforms: { ...uniforms, uSide: { value: 1 } },
        vertexShader, fragmentShader, transparent: true,
        depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      });
      resize(width, height, dpr);
      return true;
    } catch (error) {
      failed = true;
      canvas.dataset.error = 'webgl-unavailable';
      console.warn('Glass refraction unavailable:', error);
      return false;
    }
  }

  function resize(nextWidth, nextHeight, nextDpr) {
    width = nextWidth; height = nextHeight; dpr = Math.min(nextDpr || 1, 1.5);
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
    if (!renderer) return;
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(height / (2 * 760)));
    camera.aspect = width / height;
    camera.position.set(width / 2, -height / 2, 760);
    camera.lookAt(width / 2, -height / 2, 0);
    camera.updateProjectionMatrix();
    for (const material of [frontMaterial, sideMaterial]) {
      if (!material) continue;
      material.uniforms.uResolution.value.set(Math.floor(width * dpr), Math.floor(height * dpr));
      material.uniforms.uViewport.value.set(width, height);
    }
  }

  function setBackground(capture) {
    const source = capture?.canvas || capture;
    if (!source?.width || !source?.height || !initialize()) return false;
    backgroundSource = source;
    const sourceSize = `${source.width}:${source.height}`;
    if (backgroundTexture && sourceSize !== backgroundSize) {
      backgroundTexture.dispose(); backgroundTexture = null;
    }
    if (!backgroundTexture) {
      backgroundTexture = new THREE.CanvasTexture(source);
      backgroundTexture.colorSpace = THREE.SRGBColorSpace;
      backgroundTexture.generateMipmaps = false;
      backgroundTexture.minFilter = THREE.LinearFilter;
    } else {
      backgroundTexture.image = source;
      backgroundTexture.needsUpdate = true;
    }
    for (const material of [frontMaterial, sideMaterial]) {
      material.uniforms.uBackground.value = backgroundTexture;
      material.uniforms.uHasBackground.value = 1;
    }
    backgroundReady = true;
    backgroundSize = sourceSize;
    canvas.dataset.background = 'ready';
    return true;
  }

  function setDamage(source) {
    if (!initialize()) return;
    const sourceSize = `${source.width}:${source.height}`;
    if (damageTexture && sourceSize !== damageSize) {
      damageTexture.dispose(); damageTexture = null;
    }
    if (!damageTexture) {
      damageTexture = new THREE.CanvasTexture(source);
      damageTexture.colorSpace = THREE.SRGBColorSpace;
      damageTexture.generateMipmaps = false;
      damageTexture.minFilter = THREE.LinearFilter;
    } else damageTexture.needsUpdate = true;
    damageSize = sourceSize;
    for (const material of [frontMaterial, sideMaterial]) material.uniforms.uDamage.value = damageTexture;
  }

  function clearFragments() {
    fragments.forEach(({ group, front, sides }) => {
      scene?.remove(group); front.dispose(); sides.dispose();
    });
    fragments = [];
  }

  function setCells(cells) {
    if (!initialize()) return;
    clearFragments();
    fragments = cells.map(cell => {
      const { front, sides } = makeGeometry(cell, width, height);
      const group = new THREE.Group();
      group.rotation.order = 'ZYX';
      const face = new THREE.Mesh(front, frontMaterial);
      const edge = new THREE.Mesh(sides, sideMaterial);
      face.frustumCulled = edge.frustumCulled = false;
      group.add(face, edge); scene.add(group);
      return { cell, group, front, sides };
    });
    // Compile ahead of the break so the first fragment frame has no shader hitch.
    renderer.compile(scene, camera);
  }

  function hide() {
    canvas.classList.remove('is-active');
    if (renderer && frameVisible) { renderer.setScissorTest(false); renderer.clear(); }
    frameVisible = false;
  }

  function render(age, pane) {
    if (!initialize() || !fragments.length) return;
    const fadeT = THREE.MathUtils.clamp((age - 0.76) / 0.65, 0, 1);
    const opacity = 1 - fadeT * fadeT * (3 - 2 * fadeT);
    for (const material of [frontMaterial, sideMaterial]) material.uniforms.uOpacity.value = opacity;
    if (backgroundTexture && backgroundSource) backgroundTexture.needsUpdate = true;
    for (const { cell, group } of fragments) {
      const t = Math.max(0, age - cell.delay);
      group.position.set(cell.center.x + cell.vx * t, -cell.center.y - cell.vy * t - 220 * t * t, Math.min(470, cell.vz * t));
      group.rotation.set(-cell.spinX * t, cell.spinY * t, -cell.spinZ * t, 'ZYX');
    }
    renderer.setScissorTest(false); renderer.clear();
    if (pane) {
      renderer.setScissor(pane.left, height - pane.bottom, pane.right - pane.left, pane.bottom - pane.top);
      renderer.setScissorTest(true);
    }
    renderer.render(scene, camera);
    renderer.setScissorTest(false);
    frameVisible = true; canvas.classList.add('is-active');
  }

  function clear() { hide(); clearFragments(); }
  function dispose() {
    clear(); backgroundTexture?.dispose(); damageTexture?.dispose();
    frontMaterial?.dispose(); sideMaterial?.dispose(); environment?.dispose();
    room?.dispose(); empty.dispose(); renderer?.dispose(); canvas.remove();
  }
  return { resize, setBackground, setDamage, setCells, render, hide, clear, dispose,
    get state() { return { ready: !!renderer && !failed, backgroundReady, fragmentCount: fragments.length }; },
  };
}
