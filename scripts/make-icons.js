#!/usr/bin/env node
/**
 * Procedurally draws the MVLP app icon and tray icons as flat PNG files.
 * Pure-JS (Jimp) - no native/canvas dependencies, so it runs identically
 * on Windows, macOS and Linux build machines.
 *
 * electron-builder will derive .icns / .ico automatically from build/icon.png
 * as long as it is >=1024x1024 and square.
 */
const path = require('path');
const fs = require('fs');
const Jimp = require('jimp');

const BG = Jimp.rgbaToInt(17, 19, 24, 255); // #111318
const RED = Jimp.rgbaToInt(220, 53, 69, 255); // #dc3545 (brand accent)
const RED_DIM = Jimp.rgbaToInt(120, 30, 40, 255);
const LIGHT = Jimp.rgbaToInt(240, 242, 245, 255);
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

async function drawIcon(size) {
  const img = new Jimp(size, size, TRANSPARENT);
  const radius = size * 0.22;
  const mask = roundedMask(size, size, radius);

  img.scan(0, 0, size, size, function (x, y, idx) {
    const a = mask(x, y);
    if (a <= 0) return;
    const bg = Jimp.intToRGBA(BG);
    this.bitmap.data[idx + 0] = bg.r;
    this.bitmap.data[idx + 1] = bg.g;
    this.bitmap.data[idx + 2] = bg.b;
    this.bitmap.data[idx + 3] = Math.round(255 * a);
  });

  // Checkered-flag glyph made of a 4x4 grid of rounded squares, centered.
  const grid = 4;
  const pad = size * 0.22;
  const inner = size - pad * 2;
  const cell = inner / grid;
  const cellPad = cell * 0.14;
  const cellRadius = (cell - cellPad * 2) * 0.22;

  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const isRed = (gx + gy) % 2 === 0;
      const color = isRed ? RED : LIGHT;
      const x0 = pad + gx * cell + cellPad;
      const y0 = pad + gy * cell + cellPad;
      const w = cell - cellPad * 2;
      const h = cell - cellPad * 2;
      const cellMask = roundedMask(Math.ceil(w), Math.ceil(h), cellRadius);
      const rgba = Jimp.intToRGBA(color);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const a = cellMask(x, y);
          if (a <= 0) continue;
          const px = Math.round(x0 + x);
          const py = Math.round(y0 + y);
          if (px < 0 || py < 0 || px >= size || py >= size) continue;
          const idx = (py * size + px) * 4;
          img.bitmap.data[idx + 0] = rgba.r;
          img.bitmap.data[idx + 1] = rgba.g;
          img.bitmap.data[idx + 2] = rgba.b;
          img.bitmap.data[idx + 3] = Math.round(255 * a);
        }
      }
    }
  }

  // Thin accent ring near the border for depth.
  const ringMask = roundedMask(size, size, radius);
  const ringWidth = Math.max(2, size * 0.012);
  img.scan(0, 0, size, size, function (x, y, idx) {
    const distFromEdge = Math.min(x, y, size - 1 - x, size - 1 - y);
    if (distFromEdge < ringWidth && ringMask(x, y) > 0.5) {
      const rgba = Jimp.intToRGBA(RED_DIM);
      this.bitmap.data[idx + 0] = rgba.r;
      this.bitmap.data[idx + 1] = rgba.g;
      this.bitmap.data[idx + 2] = rgba.b;
    }
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
