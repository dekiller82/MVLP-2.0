'use strict';

// Draws an emulated panel in the emulator window: a screen at the panel's real resolution, scaled up and covered by a pixel mask.
// Main decodes the panel protocol (main/virtual-panel.js) and sends a description of what is showing; images
// and GIFs are handed to an <img> so the browser plays them, clock and text are drawn on a canvas.

import { resolveDots, maskImage } from './dotmask.js';

// 3x5 digits for the approximate clock.
const DIGITS = [
  '111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
  '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111',
];

const pad = (n) => String(n).padStart(2, '0');

/**
 * @param container element to fill
 * @param id        the emulated panel's id
 * @param config    { width, height, pixelStyle } of the panel
 * @returns {{ configure: (config) => void, dispose: () => void }}
 */
export function mountEmulator(container, id, config) {
  let width = 1;
  let height = 1;

  container.innerHTML = `
    <div class="emulator-bezel">
      <div class="emulator-screen">
        <img class="emulator-image" alt="" draggable="false" hidden />
        <canvas class="emulator-canvas" hidden></canvas>
      </div>
      <div class="emulator-mask"></div>
    </div>`;
  const bezel = container.querySelector('.emulator-bezel');
  const screen = container.querySelector('.emulator-screen');
  const mask = container.querySelector('.emulator-mask');
  const img = container.querySelector('.emulator-image');
  const canvas = container.querySelector('.emulator-canvas');
  const ctx = canvas.getContext('2d');
  /** The panel's size or pixel style changed. */
  function configure(next) {
    width = Math.max(1, next.width || 32);
    height = Math.max(1, next.height || 32);
    canvas.width = width;
    canvas.height = height;
    bezel.style.aspectRatio = `${width} / ${height}`;
    bezel.style.width = `min(100vw, calc(100vh * ${width} / ${height}))`;
    mask.style.backgroundSize = `calc(100% / ${width}) calc(100% / ${height})`;
    const dots = resolveDots(next);
    mask.style.backgroundImage = maskImage(dots);
    screen.style.filter = dots.boost === 100 ? '' : `brightness(${dots.boost / 100}) saturate(1.15)`; // makes up for the light the mask hides
    textStrip = null;
  }

  let state = null;
  let imageUrl = null;
  let frame = 0;
  let textStrip = null;
  let disposed = false;

  const setVisible = (el, on) => { el.hidden = !on; };

  function drawDigits(text, x, y, scale, color) {
    ctx.fillStyle = color;
    let cx = x;
    for (const ch of text) {
      if (ch === ':') {
        ctx.fillRect(cx, y + scale, scale, scale);
        ctx.fillRect(cx, y + 3 * scale, scale, scale);
        cx += 2 * scale;
        continue;
      }
      const bits = DIGITS[Number(ch)];
      for (let i = 0; i < 15; i++) if (bits[i] === '1') ctx.fillRect(cx + (i % 3) * scale, y + Math.floor(i / 3) * scale, scale, scale);
      cx += 4 * scale;
    }
  }

  function drawClock(content) {
    const now = new Date(Date.now() + state.clockOffsetMs);
    ctx.clearRect(0, 0, width, height);
    let hours = now.getHours();
    if (!content.show24h) hours = hours % 12 || 12;
    const colors = ['#ff5a5a', '#5aff8a', '#5ab4ff', '#ffd75a', '#ff5aff', '#5afff0', '#ffffff', '#ffa05a'];
    const color = colors[(content.style - 1) % colors.length];
    if (width / height <= 1.5) { // square panels stack the hours over the minutes
      const scale = Math.max(1, Math.min(Math.floor((width - 2) / 7), Math.floor((height - 4) / 11)));
      const x = Math.floor((width - (7 * scale - scale)) / 2);
      const top = Math.floor((height - 11 * scale) / 2);
      drawDigits(pad(hours), x, top, scale, color);
      drawDigits(pad(now.getMinutes()), x, top + 6 * scale, scale, color);
    } else {
      const scale = Math.max(1, Math.min(Math.floor((width - 2) / 17), Math.floor((height - 2) / 5)));
      const textWidth = 17 * scale - scale;
      drawDigits(`${pad(hours)}:${pad(now.getMinutes())}`, Math.floor((width - textWidth) / 2), Math.floor((height - 5 * scale) / 2), scale, color);
    }
  }

  function drawText(content, now) {
    if (!textStrip || textStrip.source !== content) {
      const strip = document.createElement('canvas');
      strip.width = content.width;
      strip.height = content.height;
      strip.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(content.rgba), content.width, content.height), 0, 0);
      textStrip = { source: content, canvas: strip, startedAt: now };
    }
    ctx.clearRect(0, 0, width, height);
    const y = Math.floor((height - content.height) / 2);
    const pxPerSecond = 10 + content.speed * 0.5;
    const travelled = ((now - textStrip.startedAt) / 1000) * pxPerSecond;
    const span = content.width + width;
    if (content.animation === 'scroll-left') ctx.drawImage(textStrip.canvas, Math.round(width - (travelled % span)), y);
    else if (content.animation === 'scroll-right') ctx.drawImage(textStrip.canvas, Math.round((travelled % span) - content.width), y);
    else if (content.animation === 'blink' && Math.floor((now - textStrip.startedAt) / 500) % 2) ctx.clearRect(0, 0, width, height);
    else ctx.drawImage(textStrip.canvas, Math.floor((width - content.width) / 2), y);
  }

  function tick(now) {
    if (disposed) return;
    const kind = state?.content.kind;
    if (kind === 'clock') drawClock(state.content);
    else if (kind === 'text') drawText(state.content, now);
    if (kind === 'clock' || kind === 'text') frame = requestAnimationFrame(tick);
  }

  function apply(next) {
    state = next;
    cancelAnimationFrame(frame);
    const content = state?.content ?? { kind: 'blank' };

    screen.style.opacity = state && !state.powered ? '0' : '1';

    if (imageUrl && content.kind !== 'image') {
      URL.revokeObjectURL(imageUrl);
      imageUrl = null;
    }
    if (content.kind === 'image') {
      const url = URL.createObjectURL(new Blob([content.bytes], { type: content.mime }));
      img.src = url;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      imageUrl = url;
    }
    textStrip = null;
    setVisible(img, content.kind === 'image');
    setVisible(canvas, content.kind === 'clock' || content.kind === 'text');
    if (content.kind === 'clock' || content.kind === 'text') frame = requestAnimationFrame(tick);
  }

  configure(config);
  const unsubscribe = window.mvlp.on('emulator:display', (panelId, next) => {
    if (panelId === id) apply(next);
  });
  window.mvlp.invoke('emulator:getState', id).then((current) => { if (!disposed && current) apply(current); }).catch(() => {});

  return {
    configure,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      unsubscribe();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    },
  };
}
