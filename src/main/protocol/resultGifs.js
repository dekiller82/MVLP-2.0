'use strict';

const image = require('./image');
const { GLYPHS, textUnits, fitScale } = require('./font');

/**
 * Driver-themed screens: the grid walkthrough before a race, and the winner,
 * podium and pole position screens. Drivers are drawn in their team colour, so
 * these are built from RGBA frames rather than a fixed palette.
 *
 * A driver is { number: '63', tla: 'RUS', color: '00D7B6', position?: 1 }.
 */

// ---- small drawing toolkit ----------------------------------------------------------

function hexToRgb(hex, fallback = [90, 90, 90]) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Text is always white with a black outline, on every team colour. The outline is
 * what keeps it readable on light colours (grey, light blue, teal), and using one
 * style everywhere keeps the screens consistent.
 */
function textStyleFor() {
  return { fg: [255, 255, 255], outline: [0, 0, 0] };
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function newCanvas(width, height, rgb = [0, 0, 0]) {
  const c = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  fillRect(c, 0, 0, width, height, rgb);
  return c;
}

function setPixel(c, x, y, rgb) {
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
  const o = (y * c.width + x) * 4;
  c.data[o] = rgb[0]; c.data[o + 1] = rgb[1]; c.data[o + 2] = rgb[2]; c.data[o + 3] = 255;
}

function fillRect(c, x, y, w, h, rgb) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) setPixel(c, xx, yy, rgb);
}

/**
 * Draws `text` with its left edge at `left`. With `outline`, every lit pixel of the
 * text is first surrounded by a 1 pixel border in that colour.
 */
function drawText(c, text, scale, left, top, rgb, outline = null, clip = null, gap = scale) {
  const put = (x, y, w, h, color) => {
    if (!clip) return fillRect(c, x, y, w, h, color);
    // Keep an outline from spilling out of the card it belongs to.
    const x0 = Math.max(x, clip.x);
    const x1 = Math.min(x + w, clip.x + clip.w);
    if (x1 > x0) fillRect(c, x0, y, x1 - x0, h, color);
    return undefined;
  };
  const cells = [];
  [...text].forEach((ch, i) => {
    const glyph = GLYPHS[ch];
    if (!glyph) return;
    const gx = left + i * (3 * scale + gap);
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (glyph[row][col] === '#') cells.push([gx + col * scale, top + row * scale]);
      }
    }
  });
  if (outline) for (const [x, y] of cells) put(x - 1, y - 1, scale + 2, scale + 2, outline);
  for (const [x, y] of cells) put(x, y, scale, scale, rgb);
}

/** Width in pixels of `text` at `scale` with `gap` pixels between glyphs. */
const textWidth = (text, scale, gap) => text.length * 3 * scale + (text.length - 1) * gap;

/**
 * The gap between glyphs that lets `text` sit exactly in the middle of a region
 * `regionWidth` wide. That needs the text and the region to have the same parity
 * (a 14 px number cannot be centred in a 15 px card), so gaps near the natural one
 * are tried until one fits with a pixel to spare for the outline. Falls back to the
 * natural gap when no whole-pixel centring exists.
 */
function centeringGap(text, scale, regionWidth) {
  const natural = scale;
  if (text.length < 2) return natural;
  const candidates = [natural];
  for (let d = 1; d <= 3; d++) candidates.push(natural - d, natural + d);
  for (const gap of candidates) {
    if (gap < 1) continue;
    const w = textWidth(text, scale, gap);
    if (w + 2 <= regionWidth && (regionWidth - w) % 2 === 0) return gap;
  }
  // No gap centres it exactly (e.g. three letters in an even width): at least make it fit.
  for (const gap of candidates) {
    if (gap >= 1 && textWidth(text, scale, gap) + 2 <= regionWidth) return gap;
  }
  return natural;
}

/** Draws `text` centred on the column `centerX`, within `clip` (or the whole canvas). */
function drawCentered(c, text, scale, centerX, top, rgb, outline = null, clip = null, round = Math.round) {
  const gap = centeringGap(text, scale, clip ? clip.w : c.width);
  const left = round(centerX - textWidth(text, scale, gap) / 2);
  drawText(c, text, scale, left, top, rgb, outline, clip, gap);
}

const frameOf = (c, delay) => ({ data: c.data, delay });

function encode(width, height, frames) {
  return image.encodeGif(width, height, frames, { loop: 0 });
}

/**
 * A driver's number filled into the zone [zoneTop, zoneTop + zoneHeight), as big as
 * fits, centred on `centerX` within `maxWidth`.
 */
function drawNumber(c, number, centerX, maxWidth, zoneTop, zoneHeight, rgb, outline = null, clip = null, round = Math.round, maxScale = 99) {
  const text = String(number);
  // One size for every number, as big as two digits allow (with a pixel for the outline
  // on each side), so 1 and 63 come out the same height.
  let scale = Math.min(maxScale, Math.floor(zoneHeight / 5));
  while (scale > 1 && textWidth('00', scale, 1) + 2 > maxWidth) scale--;
  drawCentered(c, text, scale, centerX, zoneTop + Math.floor((zoneHeight - 5 * scale) / 2), rgb, outline, clip || { x: 0, w: maxWidth }, round);
}

// ---- grid walkthrough ------------------------------------------------------------------

const GRID_HOLD_MS = 2400;
const GRID_SLIDE_MS = 70;
const GRID_SLIDE_STEPS = [0.25, 0.5, 0.75];

/** One driver on a coloured card: position on top, big number, three-letter code below. */
function drawDriverCard(c, driver, x0, cardWidth, leftCard) {
  const bg = hexToRgb(driver.color);
  const { fg, outline } = textStyleFor();
  const h = c.height;
  const small = Math.max(1, Math.floor(h / 32));
  const centerX = x0 + cardWidth / 2;
  const clip = { x: x0, w: cardWidth };
  fillRect(c, x0, 0, cardWidth, h, bg);

  const pos = `P${driver.position}`;
  const posScale = fitScale(pos, cardWidth - 2, small);
  const posTop = Math.round(h * 0.07);
  drawCentered(c, pos, posScale, centerX, posTop, fg, outline, clip);

  const tlaScale = fitScale(driver.tla, cardWidth - 2, small);
  const tlaTop = h - 5 * tlaScale - Math.round(h * 0.09);
  drawCentered(c, driver.tla, tlaScale, centerX, tlaTop, fg, outline, clip);

  // The number sits centred in the space between the two, at the same size as they are
  // (a bigger number crowds the card). A number at this size has an odd width, like the card,
  // so it centres exactly.
  const zoneTop = posTop + 5 * posScale + 1;
  drawNumber(c, driver.number, centerX, cardWidth, zoneTop, tlaTop - 1 - zoneTop, fg, outline, clip, Math.round, small);
}

/** Two drivers side by side: the front-row pair, then the next pair back, and so on. */
function drawPair(width, height, pair) {
  const c = newCanvas(width, height);
  const gap = width % 2 === 0 ? 2 : 1;
  const cardWidth = (width - gap) / 2;
  drawDriverCard(c, pair[0], 0, cardWidth, true);
  if (pair[1]) drawDriverCard(c, pair[1], cardWidth + gap, cardWidth, false);
  return c;
}

/**
 * A frame where `from` has moved up by `offset` pixels and `to` is pushing in from the
 * bottom: the view travels down the grid, from the front row towards the back.
 */
function slide(from, to, offset) {
  const { width, height } = from;
  const out = newCanvas(width, height);
  for (let y = 0; y < height; y++) {
    const sy = y + offset;
    const src = sy < height ? from : to;
    const row = sy < height ? sy : sy - height;
    for (let x = 0; x < width; x++) {
      const o = (row * width + x) * 4;
      setPixel(out, x, y, [src.data[o], src.data[o + 1], src.data[o + 2]]);
    }
  }
  return out;
}

/**
 * Walks the grid front to back, two drivers at a time, sliding from one pair to the
 * next, and loops.
 *
 * @param drivers grid order, pole first
 */
function makeGridWalkGif(drivers, width, height) {
  const numbered = drivers.map((d, i) => ({ ...d, position: d.position ?? i + 1 }));
  const pairs = [];
  for (let i = 0; i < numbered.length; i += 2) pairs.push(drawPair(width, height, numbered.slice(i, i + 2)));

  const frames = [];
  pairs.forEach((pair, i) => {
    frames.push(frameOf(pair, GRID_HOLD_MS));
    const next = pairs[(i + 1) % pairs.length]; // the last pair slides back round to the front row
    for (const step of GRID_SLIDE_STEPS) frames.push(frameOf(slide(pair, next, Math.round(height * step)), GRID_SLIDE_MS));
  });
  return encode(width, height, frames);
}

// ---- winner ---------------------------------------------------------------------------------

const CONFETTI_FRAMES = 8;
const CONFETTI_DELAY_MS = 110;

/** Small deterministic pseudo-random sequence, so the confetti is the same every time. */
function sequence(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The race winner: their number big on their team colour, with confetti falling. */
function makeWinnerGif(driver, width, height) {
  const bg = hexToRgb(driver.color);
  const { fg, outline } = textStyleFor();
  const palette = [[255, 255, 255], [255, 215, 0], [0, 0, 0]].filter((rgb) => distance(rgb, bg) > 80);
  const rand = sequence(20260906);
  const pieces = Array.from({ length: Math.max(6, Math.round(width / 4)) }, () => ({
    x: Math.floor(rand() * (width - 2)),
    y: Math.floor(rand() * height),
    color: palette[Math.floor(rand() * palette.length)] || fg,
    speed: 3 + Math.floor(rand() * 3),
  }));

  const label = 'WINNER';
  const small = Math.max(1, Math.floor(height / 32));
  const frames = [];
  for (let f = 0; f < CONFETTI_FRAMES; f++) {
    const c = newCanvas(width, height, bg);
    for (const p of pieces) fillRect(c, p.x, (p.y + f * p.speed) % height, 2, 2, p.color);
    drawCentered(c, label, fitScale(label, width - 2, small), width / 2, Math.round(height * 0.07), fg, outline);
    const zoneTop = Math.round(height * 0.28);
    drawNumber(c, driver.number, width / 2, width, zoneTop, Math.round(height * 0.72) - zoneTop, fg, outline);
    const tlaScale = fitScale(driver.tla, width - 2, small);
    drawCentered(c, driver.tla, tlaScale, width / 2, height - 5 * tlaScale - Math.round(height * 0.08), fg, outline);
    frames.push(frameOf(c, CONFETTI_DELAY_MS));
  }
  return encode(width, height, frames);
}

// ---- podium -----------------------------------------------------------------------------------

const MEDALS = { 1: [255, 215, 0], 2: [200, 200, 205], 3: [205, 127, 50] };

/** Draws three blocks in team colours onto `c`: second on the left, the winner tallest in the middle, third on the right. */
function drawPodium(c, top3, width, height) {
  const gap = 1;
  const blockWidth = Math.floor((width - 2 * gap) / 3);
  const used = 3 * blockWidth + 2 * gap;
  const left = Math.floor((width - used) / 2);
  const small = Math.max(1, Math.floor(height / 32));
  const layout = [
    { place: 2, column: 0, top: Math.round(height * 0.5) },
    { place: 1, column: 1, top: Math.round(height * 0.36) },
    { place: 3, column: 2, top: Math.round(height * 0.62) },
  ];

  for (const { place, column, top } of layout) {
    const driver = top3[place - 1];
    if (!driver) continue;
    const x = left + column * (blockWidth + gap);
    const bg = hexToRgb(driver.color);
    fillRect(c, x, top, blockWidth, height - 1 - top, bg);
    const centerX = x + blockWidth / 2;
    drawCentered(c, String(place), small, centerX, top - 5 * small - 2 * small, MEDALS[place]);
    const number = String(driver.number);
    const scale = fitScale(number, blockWidth, small);
    const style = textStyleFor();
    drawCentered(c, number, scale, centerX, top + 3 * small, style.fg, style.outline, { x, w: blockWidth });
  }
}

function makePodiumGif(top3, width, height) {
  const c = newCanvas(width, height);
  drawPodium(c, top3, width, height);
  return encode(width, height, [frameOf(c, 100)]);
}

// ---- pole position ----------------------------------------------------------------------------

/** Pole position: the label and the driver's three-letter code, big, on their team colour. */
function makePoleGif(driver, width, height) {
  const bg = hexToRgb(driver.color);
  const { fg, outline } = textStyleFor();
  const small = Math.max(1, Math.floor(height / 32));
  const c = newCanvas(width, height, bg);

  const label = 'POLE';
  drawCentered(c, label, fitScale(label, width, 2 * small), width / 2, Math.round(height * 0.08), fg, outline);

  // The code at the same letter height as the numbers on the other screens (bigger letters
  // fill up with their own outline and stop being legible), centred below the label.
  const code = String(driver.tla || driver.number);
  let scale = 2 * small;
  while (scale > 1 && textWidth(code, scale, 1) + 2 > width) scale--;
  const zoneTop = Math.round(height * 0.42);
  const zoneHeight = Math.round(height * 0.97) - zoneTop;
  drawCentered(c, code, scale, width / 2, zoneTop + Math.floor((zoneHeight - 5 * scale) / 2), fg, outline);
  return encode(width, height, [frameOf(c, 100)]);
}

// The drawing toolkit, shared with the idle screens.
const toolkit = { newCanvas, fillRect, drawText, drawCentered, textWidth, textStyleFor, frameOf, encode, drawPodium };

module.exports = { makeGridWalkGif, makeWinnerGif, makePodiumGif, makePoleGif, hexToRgb, toolkit };
