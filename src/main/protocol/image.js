'use strict';

const Jimp = require('jimp');
const RgbQuant = require('rgbquant');
const { GifWriter } = require('omggif');
const { parseGIF, decompressFrames } = require('gifuct-js');

const TRANSPARENT = 0x00000000;

function resizeImage(img, width, height) {
  if (width <= 0 || height <= 0) return img;
  return img.resize(width, height, Jimp.RESIZE_BICUBIC);
}

/**
 * Clips the image to the device canvas and anchors it per the `anchor` bitmask,
 * matching the original iPixel protocol's anchor semantics:
 *   0x01 align left, 0x02 align right (both/neither => horizontal center)
 *   0x10 align top,  0x20 align bottom (both/neither => vertical center)
 * anchor === 0x00 disables clipping entirely (image passed through as-is).
 */
function clipAndAnchor(img, maxWidth, maxHeight, anchor) {
  if (anchor === 0x00) return img;

  const clipW = Math.min(img.bitmap.width, maxWidth);
  const clipH = Math.min(img.bitmap.height, maxHeight);
  const clipped = img.clone().crop(0, 0, clipW, clipH);

  let offsetX;
  if (anchor & 0x01 && !(anchor & 0x02)) offsetX = 0;
  else if (anchor & 0x02 && !(anchor & 0x01)) offsetX = maxWidth - clipW;
  else offsetX = Math.max(Math.floor((maxWidth - clipW) / 2), 0);

  let offsetY;
  if (anchor & 0x10 && !(anchor & 0x20)) offsetY = 0;
  else if (anchor & 0x20 && !(anchor & 0x10)) offsetY = maxHeight - clipH;
  else offsetY = Math.max(Math.floor((maxHeight - clipH) / 2), 0);

  const canvas = new Jimp(maxWidth, maxHeight, TRANSPARENT);
  canvas.composite(clipped, offsetX, offsetY);
  return canvas;
}

async function processStill(img, maxWidth, maxHeight, anchor, autoResize) {
  let processed = img;
  if (autoResize) processed = resizeImage(processed, maxWidth, maxHeight);
  return clipAndAnchor(processed, maxWidth, maxHeight, anchor);
}

/** Reads a single still image file and prepares device-ready PNG bytes. */
async function readImageBufferForDevice(buffer, maxWidth, maxHeight, anchor, autoResize) {
  const img = await Jimp.read(buffer);
  const result = await processStill(img, maxWidth, maxHeight, anchor, autoResize);
  return result.getBufferAsync(Jimp.MIME_PNG);
}

/** Horizontally joins several images into one canvas, then fits to device dims. */
async function joinImageBuffersForDevice(buffers, maxWidth, maxHeight, anchor, autoResize) {
  if (buffers.length < 1) throw new Error('no image specified');
  const imgs = await Promise.all(buffers.map((b) => Jimp.read(b)));
  const joinedWidth = imgs.reduce((sum, im) => sum + im.bitmap.width, 0);
  const joinedHeight = Math.max(...imgs.map((im) => im.bitmap.height));
  const joined = new Jimp(joinedWidth, joinedHeight, TRANSPARENT);
  let x = 0;
  for (const im of imgs) {
    joined.composite(im, x, 0);
    x += im.bitmap.width;
  }
  const result = await processStill(joined, maxWidth, maxHeight, anchor, autoResize);
  return result.getBufferAsync(Jimp.MIME_PNG);
}

/**
 * Fully composites an animated GIF's frames into standalone RGBA raster frames,
 * honoring each frame's disposal method (GIF frames only carry a diff patch,
 * not a full frame, so naive per-frame decoding produces garbage without this).
 */
function decodeGifToRgbaFrames(buffer) {
  const parsed = parseGIF(buffer);
  const frames = decompressFrames(parsed, true);
  if (frames.length < 1) throw new Error('no frame GIF');

  const screenW = parsed.lsd.width;
  const screenH = parsed.lsd.height;
  const canvas = new Uint8ClampedArray(screenW * screenH * 4);

  const out = [];
  let prevDisposal = 0;
  let prevDims = null;
  let savedRegion = null;

  for (const frame of frames) {
    const { dims, patch } = frame;

    // Apply the PREVIOUS frame's disposal now that we're moving past it.
    if (prevDims) {
      if (prevDisposal === 2) {
        clearRect(canvas, screenW, prevDims);
      } else if (prevDisposal === 3 && savedRegion) {
        writeRect(canvas, screenW, prevDims, savedRegion);
      }
    }

    // "Restore to previous" needs a snapshot of what's under this frame
    // *before* it gets drawn.
    if (frame.disposalType === 3) {
      savedRegion = readRect(canvas, screenW, dims);
    } else {
      savedRegion = null;
    }

    compositePatch(canvas, screenW, screenH, dims, patch);

    out.push({
      data: new Uint8ClampedArray(canvas), // snapshot
      delay: frame.delay || 100,
    });

    prevDisposal = frame.disposalType || 0;
    prevDims = dims;
  }

  return { width: screenW, height: screenH, frames: out };
}

function clearRect(canvas, canvasWidth, dims) {
  for (let y = 0; y < dims.height; y++) {
    const row = (dims.top + y) * canvasWidth + dims.left;
    canvas.fill(0, (row) * 4, (row + dims.width) * 4);
  }
}

function readRect(canvas, canvasWidth, dims) {
  const out = new Uint8ClampedArray(dims.width * dims.height * 4);
  for (let y = 0; y < dims.height; y++) {
    const srcStart = ((dims.top + y) * canvasWidth + dims.left) * 4;
    const destStart = y * dims.width * 4;
    out.set(canvas.subarray(srcStart, srcStart + dims.width * 4), destStart);
  }
  return out;
}

function writeRect(canvas, canvasWidth, dims, region) {
  for (let y = 0; y < dims.height; y++) {
    const destStart = ((dims.top + y) * canvasWidth + dims.left) * 4;
    const srcStart = y * dims.width * 4;
    canvas.set(region.subarray(srcStart, srcStart + dims.width * 4), destStart);
  }
}

function compositePatch(canvas, canvasWidth, canvasHeight, dims, patch) {
  for (let y = 0; y < dims.height; y++) {
    const cy = dims.top + y;
    if (cy < 0 || cy >= canvasHeight) continue;
    for (let x = 0; x < dims.width; x++) {
      const cx = dims.left + x;
      if (cx < 0 || cx >= canvasWidth) continue;
      const srcIdx = (y * dims.width + x) * 4;
      if (patch[srcIdx + 3] === 0) continue; // transparent in this frame: keep prior pixel
      const destIdx = (cy * canvasWidth + cx) * 4;
      canvas[destIdx] = patch[srcIdx];
      canvas[destIdx + 1] = patch[srcIdx + 1];
      canvas[destIdx + 2] = patch[srcIdx + 2];
      canvas[destIdx + 3] = 255;
    }
  }
}

function rgbaBufferToJimp(data, width, height) {
  const img = new Jimp(width, height);
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(img.bitmap.data);
  return img;
}

/** Wraps a typed array so rgbquant recognizes it as ImageData (see rgbquant's getImageData switch). */
function asImageData(width, height, data) {
  const obj = { width, height, data };
  obj[Symbol.toStringTag] = 'ImageData';
  return obj;
}

/**
 * Quantizes a set of same-size RGBA frames to one shared <=256 color GIF
 * palette (index 0 reserved for transparency) and encodes an animated GIF.
 */
function encodeGif(width, height, frames, { loop = 0 } = {}) {
  const MAX_COLORS = 255; // + 1 reserved transparent slot = 256
  const quant = new RgbQuant({ colors: MAX_COLORS, method: 2, dithKern: 'FloydSteinberg', dithSerp: true });

  const binarized = frames.map((f) => binarizeAlpha(f.data));
  for (const data of binarized) {
    quant.sample(asImageData(width, height, data));
  }
  const tuples = quant.palette(true); // [[r,g,b], ...]
  const palette = [0x000000, ...tuples.map(([r, g, b]) => (r << 16) | (g << 8) | b)];
  const paletteSize = nextPow2(palette.length, 2, 256);
  while (palette.length < paletteSize) palette.push(0x000000);

  const bufSize = width * height * frames.length + 2048;
  const buf = new Uint8Array(bufSize);
  const writer = new GifWriter(buf, width, height, { loop, palette });

  binarized.forEach((data, i) => {
    const indices = new Uint8Array(width * height);
    for (let p = 0; p < width * height; p++) {
      const o = p * 4;
      if (data[o + 3] === 0) {
        indices[p] = 0;
      } else {
        const i32 = data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (255 << 24);
        const idx = quant.nearestIndex(i32);
        indices[p] = (idx === null ? 0 : idx) + 1;
      }
    }
    writer.addFrame(0, 0, width, height, indices, {
      delay: Math.max(1, Math.round((frames[i].delay || 100) / 10)),
      disposal: 2,
      transparent: 0,
      palette: undefined, // use shared global palette
    });
  });

  const end = writer.end();
  return Buffer.from(buf.buffer, 0, end);
}

function binarizeAlpha(data) {
  const out = new Uint8ClampedArray(data);
  for (let i = 3; i < out.length; i += 4) {
    out[i] = out[i] < 128 ? 0 : 255;
  }
  return out;
}

function nextPow2(n, min, max) {
  let v = min;
  while (v < n) v *= 2;
  return Math.min(v, max);
}

/** Reads an existing (possibly animated) GIF file and re-fits it to device dims. */
async function readAnimationBufferForDevice(buffer, maxWidth, maxHeight, anchor, autoResize) {
  const decoded = decodeGifToRgbaFrames(buffer);
  const processedFrames = [];
  for (const frame of decoded.frames) {
    const jimpFrame = rgbaBufferToJimp(frame.data, decoded.width, decoded.height);
    const result = await processStill(jimpFrame, maxWidth, maxHeight, anchor, autoResize);
    processedFrames.push({
      data: new Uint8ClampedArray(result.bitmap.data.buffer, result.bitmap.data.byteOffset, result.bitmap.data.byteLength),
      delay: frame.delay,
    });
  }
  return encodeGif(maxWidth, maxHeight, processedFrames, { loop: 0 });
}

/** Builds an animation from a list of still image files, each shown for `durationMs`. */
async function makeAnimationFromImagesForDevice(buffers, maxWidth, maxHeight, anchor, durationMs, autoResize) {
  const stills = await Promise.all(buffers.map((b) => Jimp.read(b)));
  const processedFrames = [];
  for (const still of stills) {
    const result = await processStill(still, maxWidth, maxHeight, anchor, autoResize);
    processedFrames.push({
      data: new Uint8ClampedArray(result.bitmap.data.buffer, result.bitmap.data.byteOffset, result.bitmap.data.byteLength),
      delay: durationMs,
    });
  }
  return encodeGif(maxWidth, maxHeight, processedFrames, { loop: 0 });
}

/** Downscales+quantizes album art to a small square GIF, matching the device palette pipeline. */
async function makeAlbumArtGif(buffer, size = 64) {
  const img = await Jimp.read(buffer);
  img.cover(size, size);
  const rgba = new Uint8ClampedArray(img.bitmap.data.buffer, img.bitmap.data.byteOffset, img.bitmap.data.byteLength);
  return encodeGif(size, size, [{ data: rgba, delay: 100 }], { loop: 0 });
}

module.exports = {
  readImageBufferForDevice,
  joinImageBuffersForDevice,
  readAnimationBufferForDevice,
  makeAnimationFromImagesForDevice,
  makeAlbumArtGif,
  processStill,
  decodeGifToRgbaFrames,
  encodeGif,
};
