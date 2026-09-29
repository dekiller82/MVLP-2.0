'use strict';

const { makePayload } = require('./common');

function erase({ eraseAll = false, buffers = [] } = {}) {
  let payload;
  if (eraseAll) {
    payload = Buffer.alloc(2 + 254);
    payload.writeUInt16LE(0x00ff, 0);
    for (let i = 0; i < 254; i++) payload[2 + i] = 0x01 + i;
  } else {
    if (!buffers.length) throw new Error('At least one buffer number must be specified.');
    payload = Buffer.alloc(2 + buffers.length);
    payload.writeUInt16LE(buffers.length, 0);
    buffers.forEach((b, i) => (payload[2 + i] = b));
  }
  return [makePayload(0x0102, payload)];
}

function brightness(value) {
  if (value < 1 || value > 100) throw new Error('Brightness must be between 1 and 100.');
  return [makePayload(0x8004, Buffer.from([value]))];
}

function defaultMode() {
  return [makePayload(0x8003, Buffer.alloc(0))];
}

function diyMode(on) {
  return [makePayload(0x0104, Buffer.from([on ? 0x01 : 0x00]))];
}

function power(on) {
  return [makePayload(0x0107, Buffer.from([on ? 0x01 : 0x00]))];
}

function upsideDown(on) {
  return [makePayload(0x8006, Buffer.from([on ? 0x01 : 0x00]))];
}

function screen(n) {
  if (n < 1 || n > 9) throw new Error('Screen must be between 1 and 9.');
  return [makePayload(0x8007, Buffer.from([n]))];
}

function prgMode(buffers) {
  if (!buffers || !buffers.length) throw new Error('At least one buffer number must be specified.');
  const payload = Buffer.alloc(2 + buffers.length);
  payload.writeUInt16LE(buffers.length, 0);
  buffers.forEach((b, i) => (payload[2 + i] = b));
  return [makePayload(0x8008, payload)];
}

function setPixel({ x, y, color = 0xffffff }) {
  const payload = Buffer.alloc(6);
  payload.writeUInt32BE(color >>> 0, 0);
  payload[4] = x;
  payload[5] = y;
  return [makePayload(0x0105, payload)];
}

/** style 1-8; date/time are JS Date objects. */
function clockMode({ style = 1, date = new Date(), showDate = true, show24h = true } = {}) {
  if (style < 1 || style > 8) throw new Error('Clock style must be between 1 and 8.');

  const timePayload = Buffer.from([date.getHours(), date.getMinutes(), date.getSeconds(), 0x00]);

  const isoWeekday = date.getDay() === 0 ? 7 : date.getDay();
  const stylePayload = Buffer.from([
    style,
    show24h ? 0x01 : 0x00,
    showDate ? 0x01 : 0x00,
    date.getFullYear() % 100,
    date.getMonth() + 1,
    date.getDate(),
    isoWeekday,
  ]);

  return [makePayload(0x8001, timePayload), makePayload(0x0106, stylePayload)];
}

function expert(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length < 2 || clean.length % 2 !== 0) throw new Error('Invalid hex payload.');
  return [Buffer.from(clean, 'hex')];
}

module.exports = {
  erase,
  brightness,
  defaultMode,
  diyMode,
  power,
  upsideDown,
  screen,
  prgMode,
  setPixel,
  clockMode,
  expert,
};
