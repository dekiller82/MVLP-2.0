#!/usr/bin/env node
/**
 * Procedurally draws the MVLP app icon (an LED panel with an M) and the tray icons as PNG files.
 * Pure-JS (Jimp) - no native/canvas dependencies, so it runs identically
 * on Windows, macOS and Linux build machines.
 *
 * electron-builder will derive .icns / .ico automatically from build/icon.png
 * as long as it is >=1024x1024 and square.
 */
const path = require('path');
const fs = require('fs');
const Jimp = require('jimp');
const { FONT_5X7 } = require('../src/main/protocol/font5x7');

const TRANSPARENT = 0x00000000;

function roundedMask(w, h, radius) {
  // Returns a function(x,y) => alpha 0..1 for a rounded-rect mask.
  return (x, y) => {
    const rx = Math.min(radius, w / 2);
    const ry = Math.min(radius, h / 2);
    const nx = x < rx ? rx - x : x > w - rx ? x - (w - rx) : 0;
    const ny = y < ry ? ry - y : y > h - ry ? y - (h - ry) : 0;
    if (nx === 0 || ny === 0) return 1;
    const dist = Math.sqrt(nx * nx + ny * ny);
    if (dist <= radius) return 1;
    if (dist <= radius + 1) return radius + 1 - dist; // 1px antialiasing
    return 0;
  };
}

// The icon: a red tile carrying an LED panel with an "M" lit on it. Lit LEDs are white round bulbs,
// unlit ones are a deeper red, so it reads as a light panel at large sizes and as a white M when tiny.
const GRID = 9;
const M_GLYPH = FONT_5X7.M;
const isLit = (x, y) => {
  const gx = x - 2;
  const gy = y - 1;
  return gy >= 0 && gy < 7 && gx >= 0 && gx < 5 && M_GLYPH[gy][gx] === '#';
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));

async function drawIcon(size) {
  const img = new Jimp(size, size, TRANSPARENT);
  const tileMask = roundedMask(size, size, size * 0.22);
  const pad = 0.13;
  const off = size * pad;
  const cell = (size * (1 - 2 * pad)) / GRID;
  const bulb = cell * 0.4;
  const BULB_LIT = [255, 250, 245];
  const BULB_UNLIT = [150, 24, 42];
  const BULB_SHADE = [128, 18, 34];

  img.scan(0, 0, size, size, function (x, y, idx) {
    const alpha = tileMask(x, y);
    if (alpha <= 0) return;
    // Tile: red, a little lighter at the top left and darker at the bottom right.
    let col = mix([232, 52, 72], [176, 26, 44], (x + y) / (2 * size));

    const gx = Math.floor((x - off) / cell);
    const gy = Math.floor((y - off) / cell);
    if (gx >= 0 && gy >= 0 && gx < GRID && gy < GRID) {
      const cx = off + (gx + 0.5) * cell;
      const cy = off + (gy + 0.5) * cell;
      const cover = Math.max(0, Math.min(1, bulb - Math.hypot(x - cx, y - cy) + 0.5));
      if (cover > 0) {
        // A small highlight toward the top left of each bulb makes it look round.
        const highlight = Math.max(0, 1 - Math.hypot(x - (cx - bulb * 0.3), y - (cy - bulb * 0.3)) / bulb);
        let bulbColor;
        if (isLit(gx, gy)) bulbColor = mix(BULB_LIT, [255, 255, 255], highlight * 0.6);
        else {
          const shade = Math.max(0, 1 - Math.hypot(x - (cx - bulb * 0.3), y - (cy - bulb * 0.3)) / (bulb * 1.3));
          bulbColor = mix(BULB_UNLIT, BULB_SHADE, 0.5 - shade * 0.3);
        }
        col = mix(col, bulbColor, cover);
      }
    }
    const d = this.bitmap.data;
    d[idx + 0] = col[0];
    d[idx + 1] = col[1];
    d[idx + 2] = col[2];
    d[idx + 3] = Math.round(255 * alpha);
  });

  return img;
}

async function drawTrayDot(size, color) {
  const img = new Jimp(size, size, TRANSPARENT);
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.42;
  const rgba = Jimp.intToRGBA(color);
  img.scan(0, 0, size, size, function (x, y, idx) {
    const dx = x - cx;
    const dy = y - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= r) {
      this.bitmap.data[idx + 0] = rgba.r;
      this.bitmap.data[idx + 1] = rgba.g;
      this.bitmap.data[idx + 2] = rgba.b;
      this.bitmap.data[idx + 3] = 255;
    } else if (d <= r + 1) {
      const a = r + 1 - d;
      this.bitmap.data[idx + 0] = rgba.r;
      this.bitmap.data[idx + 1] = rgba.g;
      this.bitmap.data[idx + 2] = rgba.b;
      this.bitmap.data[idx + 3] = Math.round(255 * a);
    }
  });
  return img;
}

async function main() {
  const buildDir = path.join(__dirname, '..', 'build');
  const assetsDir = path.join(__dirname, '..', 'assets', 'icons');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  const master = await drawIcon(1024);
  await master.writeAsync(path.join(buildDir, 'icon.png'));
  await master.writeAsync(path.join(assetsDir, 'icon-1024.png'));

  for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
    const resized = master.clone().resize(size, size, Jimp.RESIZE_BICUBIC);
    await resized.writeAsync(path.join(assetsDir, `icon-${size}.png`));
  }

  // Tray icons: neutral + status colors, at 16/32 for HiDPI.
  const trayColors = {
    idle: Jimp.rgbaToInt(140, 146, 156, 255),
    green: Jimp.rgbaToInt(58, 191, 106, 255),
    yellow: Jimp.rgbaToInt(240, 196, 25, 255),
    red: Jimp.rgbaToInt(220, 53, 69, 255),
  };
  for (const [name, color] of Object.entries(trayColors)) {
    for (const size of [16, 32]) {
      const dot = await drawTrayDot(size, color);
      await dot.writeAsync(path.join(assetsDir, `tray-${name}-${size}.png`));
    }
  }

  console.log('Icons generated in build/ and assets/icons/');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
