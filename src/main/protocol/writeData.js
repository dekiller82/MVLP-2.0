'use strict';

const { makePayload } = require('./common');
const { crc32 } = require('./crc32');
const image = require('./image');

function wrapImageData(cmd, startBuffer, data) {
  const header = Buffer.alloc(1 + 4 + 4 + 1 + 1);
  let o = 0;
  header[o++] = 0x00;
  header.writeUInt32LE(data.length, o); o += 4;
  header.writeUInt32LE(crc32(data), o); o += 4;
  header[o++] = 0x00;
  header[o++] = startBuffer;
  return makePayload(cmd, Buffer.concat([header, data]));
}

/**
 * @param opts.files array of { buffer, isGif } source file buffers
 * @param opts.startBuffer target buffer slot (1-255)
 * @param opts.deviceWidth/deviceHeight canvas size
 * @param opts.anchor anchor bitmask
 * @param opts.autoResize whether to resize before clip/anchor
 * @param opts.joinImageFiles join all files into a single PNG instead of one-per-slot
 */
async function writePng({ files, startBuffer, deviceWidth, deviceHeight, anchor, autoResize, joinImageFiles }) {
  if (!files || !files.length) throw new Error('At least one image file must be specified.');
  if (startBuffer < 1 || startBuffer > 255) throw new Error('The buffer must be between 1 and 255.');

  if (joinImageFiles) {
    const data = await image.joinImageBuffersForDevice(files, deviceWidth, deviceHeight, anchor, autoResize);
    return [wrapImageData(0x0002, startBuffer, data)];
  }

  const result = [];
  for (let i = 0; i < files.length; i++) {
    if (startBuffer + i > 0xff) break;
    const data = await image.readImageBufferForDevice(files[i], deviceWidth, deviceHeight, anchor, autoResize);
    result.push(wrapImageData(0x0002, startBuffer + i, data));
  }
  return result;
}

/**
 * @param opts.makeFromImage duration (ms) - if > 0, build one animation from the still image files
 */
async function writeGif({ files, startBuffer, deviceWidth, deviceHeight, anchor, autoResize, makeFromImage = 0 }) {
  if (!files || !files.length) throw new Error('At least one image file must be specified.');
  if (startBuffer < 1 || startBuffer > 255) throw new Error('The buffer must be between 1 and 255.');

  if (makeFromImage > 0) {
    const data = await image.makeAnimationFromImagesForDevice(files, deviceWidth, deviceHeight, anchor, makeFromImage, autoResize);
    return [wrapImageData(0x0003, startBuffer, data)];
  }

  const result = [];
  for (let i = 0; i < files.length; i++) {
    if (startBuffer + i > 0xff) break;
    const data = await image.readAnimationBufferForDevice(files[i], deviceWidth, deviceHeight, anchor, autoResize);
    result.push(wrapImageData(0x0003, startBuffer + i, data));
  }
  return result;
}

async function writeAlbumArt({ artBuffer, startBuffer, deviceWidth, deviceHeight, anchor, autoResize }) {
  const preShrunk = await image.makeAlbumArtGif(artBuffer, 64);
  const data = await image.readAnimationBufferForDevice(preShrunk, deviceWidth, deviceHeight, anchor, autoResize);
  return [wrapImageData(0x0003, startBuffer, data)];
}

module.exports = { writePng, writeGif, writeAlbumArt };
