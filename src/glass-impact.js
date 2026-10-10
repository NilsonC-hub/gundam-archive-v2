import { createGlassRefraction } from './glass-refraction.js';

// Local punctures and the advancing crack front remain in 2D. The released
// pieces use refractive geometry: their material responds to the page behind
// them and the same studio environment family as the model.
const TAU = Math.PI * 2;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = v => { const t = clamp(v); return t * t * (3 - 2 * t); };

function seeded(seed) {
  let n = seed >>> 0;
  return () => {
    n += 0x6d2b79f5;
    let t = Math.imul(n ^ n >>> 15, 1 | n);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function clipCell(polygon, nx, ny, limit) {
  const result = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const da = a.x * nx + a.y * ny - limit;
    const db = b.x * nx + b.y * ny - limit;
    if (da <= 0) result.push(a);
    if ((da <= 0) !== (db <= 0)) {
      const t = da / (da - db);
      result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return result;
}

function polygonPath(context, points) {
  context.beginPath();
  points.forEach((p, i) => i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y));
  context.closePath();
}

export function createGlassImpact({ host, reducedMotion, onImpact, onShatter, captureBackground }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'viewer-impact';
  canvas.dataset.effect = 'rifle-screen-impact';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);
  const context = canvas.getContext('2d');
  const refraction = createGlassRefraction();
  const damage = document.createElement('canvas');
  const damageContext = damage.getContext('2d');
  const texture = new Image();
  texture.decoding = 'async';
  texture.src = `${import.meta.env.BASE_URL}effects/glass-puncture.png`;
  let width = 0, height = 0, dpr = 1;
  let hits = [], chips = [], cells = [], edges = [];
  let pane = null, phase = 'idle', time = 0, thirdAt = null;
  let textureDirty = true, shattered = false, disposed = false;
  let captureRevision = 0;
  const reduced = () => typeof reducedMotion === 'boolean' ? reducedMotion : !!reducedMotion?.matches;
  texture.onload = () => { textureDirty = true; };

  function resize() {
    const nextWidth = window.innerWidth, nextHeight = window.innerHeight;
    const nextDpr = Math.min(window.devicePixelRatio || 1, 1.8);
    if (nextWidth === width && nextHeight === height && nextDpr === dpr) return;
    const previousWidth = width, previousHeight = height;
    width = nextWidth;
    height = nextHeight;
    dpr = nextDpr;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    damage.width = width;
    damage.height = height;
    refraction.resize(width, height, dpr);
    if (hits.length) {
      hits.forEach(hit => {
        hit.x *= width / previousWidth;
        hit.y *= height / previousHeight;
      });
      chips = [];
      createPane();
      if (thirdAt !== null) makeCells();
      textureDirty = true;
      requestBackground();
    }
  }
  resize();
  window.addEventListener('resize', resize, { passive: true });

  function createPane() {
    const box = host?.getBoundingClientRect();
    pane = {
      left: box ? Math.max(0, box.left) : 0,
      right: box ? Math.min(width, box.right) : width,
      top: box ? Math.max(0, box.top) : 0,
      bottom: box ? Math.min(height, box.bottom) : height,
    };
    // The V2 dock is part of the hero. Its actual top is authoritative across
    // compact and wide layouts; the shards must not cover any controls.
    const controlTops = [...document.querySelectorAll('#controls, #motion-controls, .motion-strip')]
      .map(element => element.getBoundingClientRect())
      .filter(rect => rect.height > 0 && rect.top > pane.top + 60 && rect.top < pane.bottom)
      .map(rect => rect.top);
    if (controlTops.length) pane.bottom = Math.min(pane.bottom, ...controlTops);
  }

  function requestBackground() {
    if (typeof captureBackground !== 'function' || reduced()) return;
    const revision = ++captureRevision;
    Promise.resolve().then(() => captureBackground()).then(capture => {
      if (disposed || revision !== captureRevision || !hits.length) return;
      refraction.setBackground(capture);
    }).catch(error => {
      if (revision === captureRevision) canvas.dataset.capture = 'reflection-fallback';
      console.warn('Glass background capture unavailable:', error);
    });
  }

  function makeCells() {
    const random = seeded(82431);
    const w = pane.right - pane.left, h = pane.bottom - pane.top;
    const seeds = [];
    const count = Math.round(clamp(w * h / 28000, 18, 38));
    // An irregular distribution avoids equal-sized hexagonal tiles. Broad
    // plates away from the impacts mix with thin slivers and crushed pieces.
    while (seeds.length < count) {
      const p = { x: pane.left + random() * w, y: pane.top + random() * h };
      if (seeds.every(q => Math.hypot(p.x - q.x, p.y - q.y) > 20)) seeds.push(p);
    }
    // Smaller fragments near the loaded points, larger panes toward the edges.
    hits.forEach(hit => {
      seeds.push({ x: hit.x, y: hit.y });
      for (let i = 0; i < 7; i++) {
        const angle = i / 7 * TAU + random() * .4;
        const radius = 24 + random() * 32;
        seeds.push({ x: clamp(hit.x + Math.cos(angle) * radius, pane.left + 2, pane.right - 2),
          y: clamp(hit.y + Math.sin(angle) * radius, pane.top + 2, pane.bottom - 2) });
      }
    });
    const source = hits[hits.length - 1];
    const basePolygons = seeds.map((seed, index) => {
      let poly = [{ x: pane.left, y: pane.top }, { x: pane.right, y: pane.top },
        { x: pane.right, y: pane.bottom }, { x: pane.left, y: pane.bottom }];
      seeds.forEach((other, otherIndex) => {
        if (otherIndex === index || !poly.length) return;
        poly = clipCell(poly, other.x - seed.x, other.y - seed.y,
          (other.x * other.x + other.y * other.y - seed.x * seed.x - seed.y * seed.y) / 2);
      });
      return poly;
    }).filter(poly => poly.length >= 3);
    const polygons = [];
    basePolygons.forEach(poly => {
      const area = Math.abs(poly.reduce((sum, a, i) => {
        const b = poly[(i + 1) % poly.length]; return sum + a.x * b.y - a.y * b.x;
      }, 0)) / 2;
      if (poly.length >= 4 && area > 5400 && random() < .78) {
        const start = Math.floor(random() * poly.length);
        const ring = [...poly.slice(start), ...poly.slice(0, start)];
        const split = 2 + Math.floor(random() * (poly.length - 3));
        polygons.push(ring.slice(0, split + 1), [ring[0], ...ring.slice(split)]);
      } else polygons.push(poly);
    });
    const shared = new Map();
    const cellPolygons = polygons.map(poly => {
      const outline = [];
      poly.forEach((from, i) => {
        const to = poly[(i + 1) % poly.length];
        const fromKey = `${Math.round(from.x * 100)},${Math.round(from.y * 100)}`;
        const toKey = `${Math.round(to.x * 100)},${Math.round(to.y * 100)}`;
        const forward = fromKey < toKey;
        const key = forward ? `${fromKey}|${toKey}` : `${toKey}|${fromKey}`;
        if (!shared.has(key)) {
          const a = forward ? from : to, b = forward ? to : from;
          const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
          const boundary = (Math.abs(dx) < .1 && (a.x < pane.left + .1 || a.x > pane.right - .1)) ||
            (Math.abs(dy) < .1 && (a.y < pane.top + .1 || a.y > pane.bottom - .1));
          const points = [a];
          if (!boundary && length > 12) {
            for (const fraction of [.25, .51, .77]) {
              const p = fraction + (random() - .5) * .10;
              const offset = (random() - .5) * Math.min(6.2, length * .065);
              points.push({ x: a.x + dx * p - dy / length * offset,
                y: a.y + dy * p + dx / length * offset });
            }
          }
          points.push(b);
          shared.set(key, { points, boundary, strength: .46 + random() * .54 });
        }
        const points = shared.get(key).points;
        outline.push(...(forward ? points : [...points].reverse()).slice(0, -1));
      });
      return outline;
    });
    cells = cellPolygons.map(poly => {
      const center = poly.reduce((sum, p) => ({ x: sum.x + p.x / poly.length, y: sum.y + p.y / poly.length }), { x: 0, y: 0 });
      const dx = center.x - source.x, dy = center.y - source.y;
      const distance = Math.hypot(dx, dy);
      const nearHit = Math.min(...hits.map(hit => Math.hypot(center.x - hit.x, center.y - hit.y)));
      return { poly, center, radius: Math.max(...poly.map(p => Math.hypot(p.x - center.x, p.y - center.y))),
        delay: Math.min(.13, distance / Math.max(w, h) * .18),
        vx: dx * (.58 + random() * .64) + (random() - .5) * 78,
        vy: dy * (.3 + random() * .5) - 75 - random() * 70,
        vz: 115 + random() * 290,
        spinX: (random() - .5) * 5.6, spinY: (random() - .5) * 5.2,
        spinZ: (random() - .5) * 2.3, tint: random(), reflectionAngle: random() * TAU,
        clearTexture: nearHit > 140,
      };
    });
    const dist = p => Math.min(...hits.map(hit => Math.hypot(p.x - hit.x, p.y - hit.y)));
    edges = [...shared.values()].filter(edge => !edge.boundary).map(edge => {
      const points = dist(edge.points[0]) < dist(edge.points.at(-1)) ? edge.points : [...edge.points].reverse();
      return { ...edge, points, delay: clamp(dist(points[0]) / Math.max(w * .5, h * .7), 0, .85) };
    });
    if (!reduced()) refraction.setCells(cells);
  }

  function impact({ uv, index }, at) {
    time = at;
    if (!pane) createPane();
    const random = seeded(index * 6323 + 81);
    const size = clamp(Math.min(width, height) * .28, 160, 232);
    const hit = { x: uv.x * width, y: uv.y * height, birth: at, index,
      size: size * (.92 + random() * .13), rotation: [0.24, -1.14, 1.95][index - 1] || 0 };
    hits.push(hit);
    phase = 'damaged';
    if (index === 3) { thirdAt = at; makeCells(); }
    if (index === 1 || index === 3) requestBackground();
    textureDirty = true;
    if (!reduced()) {
      for (let i = 0; i < 24; i++) {
        const angle = random() * TAU, speed = 55 + random() * 155;
        chips.push({ x: hit.x, y: hit.y, birth: at, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 40,
          size: 1.1 + random() * 3.2, spin: random() * 10 - 5, rotation: angle, life: .3 + random() * .4 });
      }
    }
    onImpact?.({ index });
    canvas.dataset.shots = String(index);
  }

  function paintHole(context2d, hit) {
    context2d.save();
    context2d.translate(hit.x, hit.y);
    context2d.rotate(hit.rotation);
    if (texture.complete && texture.naturalWidth) {
      // The alpha opening stays transparent. A thin inner bevel supplies depth,
      // while the bitmap supplies the dense crushed-glass microstructure.
      context2d.drawImage(texture, -hit.size * .512, -hit.size * .485, hit.size, hit.size);
    } else {
      context2d.beginPath();
      for (let i = 0; i < 14; i++) {
        const a = i / 14 * TAU, r = i % 3 ? 9 : 12;
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        i ? context2d.lineTo(x, y) : context2d.moveTo(x, y);
      }
      context2d.closePath();
      context2d.lineWidth = 4;
      context2d.strokeStyle = 'rgba(231,245,248,.7)';
      context2d.stroke();
      context2d.lineWidth = .9;
      context2d.strokeStyle = 'rgba(32,47,54,.6)';
      context2d.stroke();
    }
    context2d.restore();
  }

  function rebuildDamage() {
    damageContext.clearRect(0, 0, width, height);
    hits.forEach(hit => paintHole(damageContext, hit));
    if (!reduced()) refraction.setDamage(damage);
    textureDirty = false;
  }

  function drawCracks(progress, target = context, alpha = 1) {
    target.lineJoin = 'bevel';
    target.lineCap = 'butt';
    const trace = (points, progress, dx, dy) => {
      const reach = progress * (points.length - 1), full = Math.floor(reach);
      target.beginPath(); target.moveTo(points[0].x + dx, points[0].y + dy);
      for (let i = 1; i <= full; i++) target.lineTo(points[i].x + dx, points[i].y + dy);
      if (full < points.length - 1) {
        const a = points[full], b = points[full + 1], t = reach - full;
        target.lineTo(a.x + (b.x - a.x) * t + dx, a.y + (b.y - a.y) * t + dy);
      }
      target.stroke();
    };
    edges.forEach(edge => {
      const p = smooth((progress - edge.delay * .56) / .36);
      if (p <= 0) return;
      // Narrow, paired edges are reflections across a fissure, not black spokes.
      target.lineWidth = .55;
      target.strokeStyle = `rgba(28,50,59,${.20 * edge.strength * alpha})`;
      trace(edge.points, p, 0, 0);
      target.lineWidth = .65;
      target.strokeStyle = `rgba(250,255,255,${.55 * edge.strength * alpha})`;
      trace(edge.points, p, .6, -.45);
    });
  }

  function drawChips() {
    chips = chips.filter(chip => time - chip.birth < chip.life);
    chips.forEach(chip => {
      const age = time - chip.birth, alpha = Math.pow(1 - age / chip.life, .5);
      context.save();
      context.translate(chip.x + chip.vx * age, chip.y + chip.vy * age + 145 * age * age);
      context.rotate(chip.rotation + chip.spin * age);
      const s = chip.size * (.5 + Math.abs(Math.cos(age * 12)) * .5);
      polygonPath(context, [{ x: -s, y: -s * .3 }, { x: s * .6, y: -s }, { x: s * .3, y: s }]);
      context.fillStyle = `rgba(224,244,247,${alpha * .45})`; context.fill();
      context.strokeStyle = `rgba(255,255,255,${alpha * .85})`; context.lineWidth = .65; context.stroke();
      context.restore();
    });
  }

  function update(at) {
    if (disposed) return;
    time = at;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!hits.length || phase === 'complete') {
      canvas.classList.remove('is-active');
      refraction.hide();
      return;
    }
    canvas.classList.add('is-active');
    if (textureDirty) rebuildDamage();
    const thirdAge = thirdAt === null ? -1 : time - thirdAt;
    if (thirdAge >= .95 && !shattered) {
      shattered = true; phase = 'shattering';
      onShatter?.({ index: 3 });
    } else if (thirdAge >= .3 && !shattered) phase = 'propagating';
    if (thirdAge >= 2.45) {
      phase = 'complete'; canvas.classList.remove('is-active');
      refraction.hide();
      chips = [];
      canvas.dataset.phase = phase;
      return;
    }
    context.save();
    context.beginPath();
    context.rect(pane.left, pane.top, pane.right - pane.left, pane.bottom - pane.top);
    context.clip();
    if (shattered && !reduced()) {
      refraction.render(thirdAge - .95, pane);
    } else {
      refraction.hide();
      if (reduced() && shattered) context.globalAlpha = 1 - smooth((thirdAge - .95) / .45);
      context.drawImage(damage, 0, 0);
      if (!reduced() && thirdAge >= .3) drawCracks((thirdAge - .3) / .65);
    }
    if (!reduced()) drawChips();
    context.restore();
    canvas.dataset.phase = phase;
  }

  function clear() {
    captureRevision++; refraction.clear();
    hits = []; chips = []; cells = []; edges = []; pane = null;
    phase = 'idle'; thirdAt = null; shattered = false; textureDirty = true;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    damageContext.clearRect(0, 0, width, height);
    canvas.classList.remove('is-active');
    canvas.dataset.phase = phase; canvas.dataset.shots = '0';
  }

  function dispose() {
    clear(); disposed = true;
    window.removeEventListener('resize', resize);
    texture.onload = null; canvas.remove(); refraction.dispose();
  }

  return { impact, update, clear, dispose,
    get canvas() { return canvas; },
    get active() { return hits.length > 0 && phase !== 'complete'; },
    get state() { return Object.freeze({ phase, hitCount: hits.length, shardCount: phase === 'shattering' ? cells.length : 0,
      textureReady: texture.complete && texture.naturalWidth > 0, refraction: refraction.state }); },
  };
}
