'use strict';

const fs = require('fs');
const { GifWriter } = require('omggif');
const image = require('./image');

// Deliberately blue-heavy: on an LED panel the red channel dominates, so a
// "proper" purple like #b138dd reads as magenta.
const PURPLE = 0x5a00ff;

// One full pulse takes 8 steps of 100 ms; brightness follows a smooth rise and fall.
const PULSE_STEPS = [0.3, 0.55, 0.8, 1, 0.8, 0.55, 0.3, 0.15];
const STEP_MS = 100;

/** Blacks out the outer band: the source SC/VSC art has its own (yellow) border there. */
function clearEdge(data, width, height, band) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= band && x < width - band && y >= band && y < height - band) continue;
      const o = (y * width + x) * 4;
      data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 255;
    }
  }
}

/**
 * Paints a two-ring border in place: a bright outer ring and a dimmer inner
 * ring (like the bundled yellow flag), each `thickness` px wide.
 */
function drawBorder(data, width, height, thickness, rgb, level) {
  const paint = (ring, scale) => {
    const r = Math.round(rgb[0] * level * scale);
    const g = Math.round(rgb[1] * level * scale);
    const b = Math.round(rgb[2] * level * scale);
    const lo = ring * thickness;
    const hi = lo + thickness;
    for (let y = lo; y < height - lo; y++) {
      for (let x = lo; x < width - lo; x++) {
        const depth = Math.min(x, y, width - 1 - x, height - 1 - y);
        if (depth < lo || depth >= hi) continue;
        const o = (y * width + x) * 4;
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
      }
    }
  };
  paint(0, 1);
  paint(1, 0.45);
}

/**
 * Reuses an existing animation (the SC / VSC gifs) and adds a pulsing green
 * border to it, for "safety car in this lap" / "VSC ending". The original's
 * own animation keeps playing underneath at its native timing.
 */
async function makeGreenBorderGif(gifPath, width, height) {
  const fitted = await image.readAnimationBufferForDevice(fs.readFileSync(gifPath), width, height, 0x33, true);
  const { frames: base } = image.decodeGifToRgbaFrames(fitted);
  const cycleMs = base.reduce((sum, f) => sum + f.delay, 0);
  const thickness = Math.max(1, Math.round(Math.min(width, height) / 32));

  // Sample the source animation at each pulse step (the pulse cycle repeats
  // every 800 ms, which is a whole number of the source's loops for 2x200 ms).
  const frames = PULSE_STEPS.map((level, step) => {
    let t = (step * STEP_MS) % cycleMs;
    let src = base[0];
    for (const f of base) {
      if (t < f.delay) { src = f; break; }
      t -= f.delay;
    }
    const data = new Uint8ClampedArray(src.data);
    clearEdge(data, width, height, thickness * 2);
    drawBorder(data, width, height, thickness, [0, 255, 0], level);
    return { data, delay: STEP_MS };
  });
  return image.encodeGif(width, height, frames, { loop: 0 });
}

/** Solid purple screen for a new overall fastest lap (the caller decides how long to show it). */
function makeFastestLapGif(width, height) {
  const buf = new Uint8Array(width * height + 1024);
  const writer = new GifWriter(buf, width, height, { loop: 0, palette: [PURPLE, 0x000000] });
  writer.addFrame(0, 0, width, height, new Uint8Array(width * height), { delay: 100, disposal: 1 });
  return Buffer.from(buf.buffer, 0, writer.end());
}

const SCAN_COLOR = [0, 220, 255]; // the bright line that sweeps down while revealing the logo
const SCAN_STEP_MS = 40;
const LOGO_HOLD_MS = 2000;

/**
 * Startup animation: a scan line sweeps down the panel, revealing the MVLP logo
 * behind it, which then holds. About 0.7 s of motion, so it's obvious the app has
 * connected without getting in the way.
 */
async function makeStartupGif(logoPath, width, height) {
  const fitted = await image.readAnimationBufferForDevice(fs.readFileSync(logoPath), width, height, 0x33, true);
  const logo = image.decodeGifToRgbaFrames(fitted).frames[0].data;
  const rowsPerStep = Math.max(1, Math.round(height / 16));
  const line = Math.max(1, Math.round(height / 32));

  const frames = [];
  for (let edge = 0; edge < height + line; edge += rowsPerStep) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        if (y < edge) {
          data[o] = logo[o]; data[o + 1] = logo[o + 1]; data[o + 2] = logo[o + 2]; data[o + 3] = 255;
        } else if (y < edge + line) {
          data[o] = SCAN_COLOR[0]; data[o + 1] = SCAN_COLOR[1]; data[o + 2] = SCAN_COLOR[2]; data[o + 3] = 255;
        } else {
          data[o + 3] = 255; // black
        }
      }
    }
    frames.push({ data, delay: SCAN_STEP_MS });
  }
  const finalLogo = new Uint8ClampedArray(logo);
  for (let i = 3; i < finalLogo.length; i += 4) finalLogo[i] = 255;
  frames.push({ data: finalLogo, delay: LOGO_HOLD_MS });
  return image.encodeGif(width, height, frames, { loop: 0 });
}

module.exports = { makeGreenBorderGif, makeFastestLapGif, makeStartupGif };
