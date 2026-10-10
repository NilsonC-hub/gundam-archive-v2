import * as THREE from 'three';

// A photographic print treatment. Its vertex relief is deliberately artistic,
// not a depth reconstruction of the hangar or a substitute for the 3D model.
const vertexShader = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uImage;
  uniform vec2 uPointer;
  uniform float uAspect;
  uniform float uTime;
  uniform float uMotion;

  void main() {
    vUv = uv;
    vec3 p = position;
    p.x *= uAspect;
    p.xy *= 1.055;
    float imageRelief = dot(texture2D(uImage, uv).rgb,
      vec3(0.2126, 0.7152, 0.0722)) - 0.5;
    float wave = sin(uv.x * 4.5 + uv.y * 2.0 + uTime * 0.19);
    p.z += (imageRelief * 0.052 + wave * 0.009) * uMotion;
    p.xy += uPointer * (imageRelief * 0.018 + 0.009) * uMotion;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  varying vec2 vUv;
  uniform sampler2D uImage;
  uniform vec2 uImageSize;
  uniform vec2 uObjectPosition;
  uniform vec2 uViewport;
  uniform vec2 uResolution;
  uniform vec2 uPointer;
  uniform vec2 uReveal;
  uniform float uTime;
  uniform float uMotion;

  float hangarLuma(vec3 color) {
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
  }

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  vec2 coverUv(vec2 uv) {
    float imageAspect = uImageSize.x / uImageSize.y;
    float viewAspect = uViewport.x / uViewport.y;
    vec2 scale = vec2(min(viewAspect / imageAspect, 1.0),
                      min(imageAspect / viewAspect, 1.0));
    // Subtle overscan allows pointer displacement without exposing an edge.
    return (uv - 0.5) * scale * 0.978 + 0.5
         + (uObjectPosition - 0.5) * (1.0 - scale);
  }

  void main() {
    float aspect = uViewport.x / uViewport.y;
    vec2 sourceUv = coverUv(vUv);
    sourceUv += uPointer * vec2(0.0030, 0.0018) * uMotion;
    float lum = hangarLuma(texture2D(uImage, sourceUv).rgb);
    // Keep the original tonal range; the page supplies its own text gradient.
    vec3 photo = vec3(pow(max(lum, 0.0), 0.95));

    vec2 cssPixel = gl_FragCoord.xy / uResolution * uViewport;
    mat2 screenRotation = mat2(0.8192, -0.5736, 0.5736, 0.8192);
    vec2 cell = fract(screenRotation * cssPixel / 3.35) - 0.5;
    float radius = sqrt(clamp(1.0 - lum, 0.0, 1.0)) * 0.72;
    float ink = 1.0 - smoothstep(radius - 0.07, radius + 0.07, length(cell));
    vec3 paper = vec3(0.79, 0.80, 0.77);
    vec3 charcoal = vec3(0.014, 0.016, 0.015);
    vec3 printTone = mix(paper, charcoal, ink);
    vec3 archive = mix(photo, printTone, 0.18);

    // A restrained warm red ink trace lives only in the midtone print dots.
    float midtone = smoothstep(0.08, 0.27, lum)
                 * (1.0 - smoothstep(0.42, 0.78, lum));
    archive = mix(archive, vec3(0.30, 0.025, 0.016), midtone * ink * 0.045);

    vec2 lensDelta = (vUv - uReveal) * vec2(aspect, 1.0);
    float radiusReveal = 0.23 + sin(uTime * 0.38) * 0.008 * uMotion;
    float reveal = 1.0 - smoothstep(radiusReveal * 0.58,
                                  radiusReveal, length(lensDelta));
    vec3 color = mix(archive, photo, reveal * 0.97);

    // The broad, low-contrast moving exposure band never becomes a HUD line.
    float scanY = uReveal.y + sin(uTime * 0.28) * 0.16 * uMotion;
    float exposure = exp(-pow((vUv.y - scanY) * 40.0, 2.0))
                   * exp(-pow(lensDelta.x * 3.5, 2.0));
    color += vec3(0.019, 0.012, 0.008) * exposure * uMotion;
    // Static, subtle grain avoids temporal shimmer and compression noise.
    color += (hash(floor(cssPixel)) - 0.5) * 0.0035;

    gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * Enhance the dossier photograph. The returned function removes this effect.
 * The original image remains visible until a successful GPU frame is rendered.
 * @param {HTMLElement} container
 * @param {HTMLImageElement} imgElement
 * @returns {() => void} cleanup
 */
export function initHangarShader(container, imgElement) {
  if (!container || !imgElement) return () => {};

  let disposed = false;
  let failed = false;
  let running = false;
  let visible = true;
  let initialized = false;
  let frame = 0;
  let lastTime = 0;
  let elapsed = 0;
  let renderer;
  let scene;
  let camera;
  let geometry;
  let material;
  let texture;
  let observer;
  let resizeObserver;
  let uniforms;
  const previousVisibility = imgElement.style.visibility;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const targetPointer = new THREE.Vector2(0, 0);
  const targetReveal = new THREE.Vector2(0.66, 0.53);

  function stop() {
    running = false;
    cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
  }

  function fallback() {
    failed = true;
    stop();
    imgElement.style.visibility = previousVisibility;
    renderer?.domElement.remove();
  }

  function render() {
    if (!initialized || failed || disposed || !visible || document.hidden) return;
    try {
      renderer.render(scene, camera);
      if (!failed) imgElement.style.visibility = 'hidden';
    } catch {
      fallback();
    }
  }

  function tick(now) {
    if (!running || failed || disposed) return;
    // An atmospheric layer needs only 30 GPU frames/s, including on 144 Hz screens.
    if (lastTime && now - lastTime < 1000 / 30) {
      frame = requestAnimationFrame(tick);
      return;
    }
    const delta = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 1 / 60;
    lastTime = now;
    elapsed += delta;
    uniforms.uTime.value = elapsed;
    const ease = 1 - Math.exp(-delta * 4.8);
    uniforms.uPointer.value.lerp(targetPointer, ease);
    uniforms.uReveal.value.lerp(targetReveal, ease);
    render();
    if (running) frame = requestAnimationFrame(tick);
  }

  function syncPlayback() {
    if (!initialized || disposed || failed) return;
    uniforms.uMotion.value = reducedMotion.matches ? 0 : 1;
    const shouldRun = visible && !document.hidden && !reducedMotion.matches;
    if (!shouldRun) {
      stop();
      render();
    } else if (!running) {
      running = true;
      frame = requestAnimationFrame(tick);
    }
  }

  function resize() {
    if (!initialized || disposed || failed) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(width, height, false);
    renderer.getDrawingBufferSize(uniforms.uResolution.value);
    uniforms.uViewport.value.set(width, height);
    uniforms.uAspect.value = width / height;
    const position = getComputedStyle(imgElement).objectPosition.split(' ');
    const fraction = (value) => {
      if (value === 'left' || value === 'top') return 0;
      if (value === 'right' || value === 'bottom') return 1;
      return value?.endsWith('%') ? parseFloat(value) / 100 : 0.5;
    };
    uniforms.uObjectPosition.value.set(fraction(position[0]), 1 - fraction(position[1]));
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    render();
  }

  function pointerMove(event) {
    if (!initialized || failed || disposed) return;
    const rect = container.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = THREE.MathUtils.clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const y = 1 - THREE.MathUtils.clamp((event.clientY - rect.top) / rect.height, 0, 1);
    targetPointer.set((x - 0.5) * 2, (y - 0.5) * 2);
    targetReveal.set(x, y);
    if (reducedMotion.matches) {
      uniforms.uReveal.value.copy(targetReveal);
      render();
    }
  }

  function pointerLeave() {
    targetPointer.set(0, 0);
    targetReveal.set(0.66, 0.53);
    if (initialized && reducedMotion.matches) {
      uniforms.uReveal.value.copy(targetReveal);
      render();
    }
  }

  function contextLost(event) {
    event.preventDefault();
    fallback();
  }

  function initialize() {
    if (initialized || disposed || failed || !imgElement.naturalWidth) return;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false,
        powerPreference: 'low-power' });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
        console.warn('Hangar shader unavailable; retaining photograph.',
          gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex),
          gl.getShaderInfoLog(fragment));
        fallback();
      };
      const canvas = renderer.domElement;
      canvas.className = 'hangar-shader-canvas';
      canvas.setAttribute('aria-hidden', 'true');
      Object.assign(canvas.style, {
        position: 'absolute', inset: '0', zIndex: '0',
        width: '100%', height: '100%', pointerEvents: 'none', display: 'block',
      });
      canvas.addEventListener('webglcontextlost', contextLost);
      texture = new THREE.Texture(imgElement);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.needsUpdate = true;
      uniforms = {
        uImage: { value: texture },
        uImageSize: { value: new THREE.Vector2(imgElement.naturalWidth, imgElement.naturalHeight) },
        uObjectPosition: { value: new THREE.Vector2(0.5, 0.5) },
        uViewport: { value: new THREE.Vector2(1, 1) },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uAspect: { value: 1 },
        uPointer: { value: new THREE.Vector2() },
        uReveal: { value: targetReveal.clone() },
        uTime: { value: 0 },
        uMotion: { value: reducedMotion.matches ? 0 : 1 },
      };
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10);
      camera.position.z = 1 / Math.tan(THREE.MathUtils.degToRad(22.5));
      geometry = new THREE.PlaneGeometry(2, 2, 100, 40);
      material = new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms,
        depthTest: false, depthWrite: false });
      scene.add(new THREE.Mesh(geometry, material));
      const rect = container.getBoundingClientRect();
      visible = rect.bottom > 0 && rect.top < window.innerHeight;
      initialized = true;
      container.appendChild(canvas);
      resize();
      renderer.compile(scene, camera);
      if (failed) return;
      syncPlayback();
    } catch {
      fallback();
    }
  }

  imgElement.addEventListener('load', initialize);
  imgElement.addEventListener('error', fallback);
  container.addEventListener('pointermove', pointerMove, { passive: true });
  container.addEventListener('pointerleave', pointerLeave);
  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', syncPlayback);
  reducedMotion.addEventListener('change', syncPlayback);

  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      syncPlayback();
    }, { threshold: 0 });
    observer.observe(container);
  }
  if ('ResizeObserver' in window) {
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
  }
  if (imgElement.complete && imgElement.naturalWidth) initialize();

  return function disposeHangarShader() {
    if (disposed) return;
    disposed = true;
    stop();
    observer?.disconnect();
    resizeObserver?.disconnect();
    imgElement.removeEventListener('load', initialize);
    imgElement.removeEventListener('error', fallback);
    container.removeEventListener('pointermove', pointerMove);
    container.removeEventListener('pointerleave', pointerLeave);
    window.removeEventListener('resize', resize);
    document.removeEventListener('visibilitychange', syncPlayback);
    reducedMotion.removeEventListener('change', syncPlayback);
    renderer?.domElement.removeEventListener('webglcontextlost', contextLost);
    renderer?.domElement.remove();
    geometry?.dispose();
    material?.dispose();
    texture?.dispose();
    renderer?.dispose();
    imgElement.style.visibility = previousVisibility;
  };
}
