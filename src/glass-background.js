import { toCanvas, getFontEmbedCSS } from 'html-to-image';

// Only the paper/type layer is rasterized. The model is composited again after
// each real renderer frame, so refraction follows the living scene rather than
// carrying a photograph on the fragment surface.
export function createGlassBackground({ host, stage, renderer }) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  let backdrop = null, inFlight = null, fontCSS = null, cacheKey = '';
  let captureError = null, captureCount = 0, frameCount = 0;
  let scale = 1, width = 0, height = 0;

  function dimensions() {
    const nextWidth = window.innerWidth, nextHeight = window.innerHeight;
    const nextScale = Math.min(window.devicePixelRatio || 1, 1.25);
    const key = `${nextWidth}:${nextHeight}:${nextScale}:${window.scrollY}`;
    return { nextWidth, nextHeight, nextScale, key };
  }

  async function capture() {
    const next = dimensions();
    if (backdrop && cacheKey === next.key) {
      return { canvas, viewportWidth: width, viewportHeight: height };
    }
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        await document.fonts.ready;
        fontCSS ??= await getFontEmbedCSS(host, { preferredFontFormat: 'woff2' });
        const background = getComputedStyle(document.documentElement).backgroundColor;
        const result = await toCanvas(document.body, {
          width: next.nextWidth,
          height: next.nextHeight,
          pixelRatio: next.nextScale,
          backgroundColor: background,
          fontEmbedCSS: fontCSS,
          preferredFontFormat: 'woff2',
          style: { margin: '0', transform: `translateY(${-window.scrollY}px)` },
          filter: node => {
            if (!(node instanceof Element)) return true;
            if (node === stage || node.tagName === 'CANVAS' || node.tagName === 'SCRIPT'
              || node.matches('.viewer-impact, .glass-overlay, .dossier, .chronicle, .footer')) return false;
            return true;
          },
        });
        width = next.nextWidth;
        height = next.nextHeight;
        scale = next.nextScale;
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        backdrop = result;
        cacheKey = next.key;
        captureCount++;
        captureError = null;
        // The next post-render update adds the live model without requesting a
        // permanently preserved WebGL framebuffer or a second main-scene render.
        context.drawImage(backdrop, 0, 0, canvas.width, canvas.height);
        return { canvas, viewportWidth: width, viewportHeight: height };
      } catch (error) {
        captureError = error instanceof Error ? error.message : String(error);
        console.warn('Glass background capture unavailable:', captureError);
        return null;
      } finally { inFlight = null; }
    })();
    return inFlight;
  }

  function update() {
    if (!backdrop) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(backdrop, 0, 0, canvas.width, canvas.height);
    const rect = stage.getBoundingClientRect();
    context.drawImage(renderer.domElement,
      rect.left * scale, rect.top * scale, rect.width * scale, rect.height * scale);
    frameCount++;
  }

  return {
    capture, update,
    get canvas() { return canvas; },
    get state() { return { ready: !!backdrop, captureCount, frameCount, error: captureError, width, height }; },
  };
}
