'use strict';

const { GifWriter } = require('omggif');

// Palette indices.
const BLACK = 0;
const TRACK = 1;
const YELLOW = 2;
const DIM_YELLOW = 3;
const PALETTE = [0x000000, 0x8a8a8a, 0xffff00, 0x4a4a00];

const FRAME_DELAY_CS = 25; // same flash rate as the bundled yellow.gif (250 ms)

/**
 * Circuit outline projected onto a width x height grid, with each point tagged
 * with the marshal sector it belongs to.
 *
 * @param circuit { x:number[], y:number[], rotation:number, marshal:[{number,length}] }
 *                x/y is the track polyline; `length` is each marshal sector's start
 *                distance along the lap, in the same units as the polyline.
 */
function projectTrack(circuit, width, height) {
  const { x, y, marshal } = circuit;
  const angle = ((circuit.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // Rotate as Multiviewer does, and flip y (feed coordinates have y pointing up).
  const pts = x.map((px, i) => ({ x: px * cos - y[i] * sin, y: -(px * sin + y[i] * cos) }));

  // Distance along the lap at each point, to find which marshal sector it is in.
  const along = [0];
  for (let i = 1; i < pts.length; i++) along.push(along[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const starts = [...marshal].sort((a, b) => a.length - b.length);
  const sectorAt = (d) => {
    let found = starts[starts.length - 1]; // before the first start: wraps to the last sector
    for (const m of starts) if (m.length <= d) found = m;
    return found.number;
  };

  const minX = Math.min(...pts.map((p) => p.x));
  const maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  const margin = Math.max(2, Math.round(Math.min(width, height) / 12));
  const scale = Math.min((width - 1 - 2 * margin) / (maxX - minX || 1), (height - 1 - 2 * margin) / (maxY - minY || 1));
  const offX = (width - 1 - (maxX - minX) * scale) / 2 - minX * scale;
  const offY = (height - 1 - (maxY - minY) * scale) / 2 - minY * scale;

  return {
    scale,
    offX,
    offY,
    points: pts.map((p, i) => ({ px: Math.round(p.x * scale + offX), py: Math.round(p.y * scale + offY), sector: sectorAt(along[i]) })),
  };
}

function plot(px, width, height, x, y, color) {
  if (x >= 0 && x < width && y >= 0 && y < height) px[y * width + x] = color;
}

function line(px, width, height, x0, y0, x1, y1, color) {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    plot(px, width, height, x0, y0, color);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

/**
 * One frame: the track in grey with the flagged sectors drawn over it in
 * `flagColor`. The flagged stretch is exactly as wide as the track (one pixel), so
 * it can't spill onto other parts of the circuit that run close by, and there is
 * no start/finish marker: the encoder that prepares images for the panel drops
 * colours that occur in only one pixel, and merged it into the nearest colour.
 */
function renderFrame(track, flagged, flagColor, width, height) {
  const px = new Uint8Array(width * height).fill(BLACK);
  const pts = track.points;
  const n = pts.length;

  // Track first, so flagged stretches are drawn on top of it.
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    line(px, width, height, a.px, a.py, b.px, b.py, TRACK);
  }
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    if (!flagged.has(a.sector)) continue; // a segment belongs to the sector it starts in
    const b = pts[(i + 1) % n];
    line(px, width, height, a.px, a.py, b.px, b.py, flagColor);
  }
  return px;
}

const FLASH_MS = 250; // per phase, like the bundled yellow.gif
const FAST_FLASH_MS = 180; // double yellow: faster than a single yellow, but not a strobe
const INTRO_FLASHES = 3;
// The controller switches to the looping map about 3 s after the animation starts, so
// the animation is sized to run that long whatever the flash speed (no pause before the swap).
const INTRO_TARGET_MS = 3000;
const FINAL_HOLD_MS = 5000;

/**
 * Yellow-flag minimap. It starts like the big yellow flag, with full-screen
 * yellow/black flashes to get attention, then shows the circuit with the flagged
 * sectors lit (flashing briefly) and holds on that.
 *
 * Returns `{ gif, loop }`: `loop` is just the flashing map (bright/dim, repeating),
 * which is what the panel is switched to once the intro is done so the flagged
 * line keeps flashing.
 *
 * @param flaggedSectors iterable of marshal sector numbers
 * @param opts.fast      flash at double speed (double yellow)
 */
function makeYellowMap(circuit, flaggedSectors, width, height, { fast = false } = {}) {
  const track = projectTrack(circuit, width, height);
  const flagged = new Set(flaggedSectors);
  const bright = renderFrame(track, flagged, YELLOW, width, height);
  const dim = renderFrame(track, flagged, DIM_YELLOW, width, height);
  const full = new Uint8Array(width * height).fill(YELLOW);
  const dark = new Uint8Array(width * height).fill(BLACK);
  const cs = Math.round((fast ? FAST_FLASH_MS : FLASH_MS) / 10);

  const phaseMs = fast ? FAST_FLASH_MS : FLASH_MS;
  const mapFlashes = Math.max(2, Math.round((INTRO_TARGET_MS - INTRO_FLASHES * 2 * phaseMs) / (2 * phaseMs)));
  const frameCount = (INTRO_FLASHES + mapFlashes) * 2 + 1;
  const buf = new Uint8Array(width * height * frameCount + 1024);
  const writer = new GifWriter(buf, width, height, { loop: 0, palette: PALETTE });
  const add = (pixels, delay) => writer.addFrame(0, 0, width, height, pixels, { delay, disposal: 1 });
  for (let i = 0; i < INTRO_FLASHES; i++) { add(full, cs); add(dark, cs); }
  for (let i = 0; i < mapFlashes; i++) { add(bright, cs); add(dim, cs); }
  add(bright, Math.round(FINAL_HOLD_MS / 10));
  const gif = Buffer.from(buf.buffer, 0, writer.end());

  const loopBuf = new Uint8Array(width * height * 2 + 1024);
  const loopWriter = new GifWriter(loopBuf, width, height, { loop: 0, palette: PALETTE });
  loopWriter.addFrame(0, 0, width, height, bright, { delay: cs, disposal: 1 });
  loopWriter.addFrame(0, 0, width, height, dim, { delay: cs, disposal: 1 });
  return { gif, loop: Buffer.from(loopBuf.buffer, 0, loopWriter.end()) };
}

module.exports = { makeYellowMap, projectTrack };
