'use strict';

const { EventEmitter } = require('events');

/** Ids of emulated panels start with this; real panels advertise LED_BLE_ or iPixel names. */
const EMULATED_PREFIX = 'Emulator-';
const isEmulatedId = (id) => String(id).startsWith(EMULATED_PREFIX);

const IMAGE_HEADER_BYTES = 11; // option, size u32, crc u32, 0x00, slot (see protocol/writeData.js)

/**
 * A stand-in for a physical panel. It receives exactly the frames the app would write over Bluetooth,
 * decodes the ones that change what the panel shows, and emits a `display` event with a description the
 * window can draw. Nothing here knows about Bluetooth or the window.
 *
 * Frame: [length u16][command u16][data...]. Handled commands:
 *   0x0002 png, 0x0003 gif   an image written to a slot; the panel shows it straight away
 *   0x0100 text mode         scrolling text, sent in windows of up to 12 KiB
 *   0x0106 / 0x8001          clock style / set the panel's time
 *   0x0102 erase, 0x0107 power
 * Brightness (0x8004) and upside down (0x8006) are ignored: an emulated panel is always at full brightness and upright.
 * Everything else (modes, screens, single pixels) is accepted and ignored.
 */
class VirtualPanel extends EventEmitter {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    this.powered = true;
    this.clockOffsetMs = 0; // panel time minus this computer's time
    this.content = { kind: 'blank' };
    this.textParts = null;
  }

  /** Everything the window needs to draw the panel right now. */
  getState() {
    return { content: this.content, powered: this.powered, clockOffsetMs: this.clockOffsetMs };
  }

  /** Accepts the payload buffers of one write. */
  receive(payloads) {
    for (const payload of payloads) this._frame(payload);
    this.emit('display', this.getState());
  }

  _frame(frame) {
    if (frame.length < 4) return;
    const command = frame.readUInt16LE(2);
    const data = frame.subarray(4);
    switch (command) {
      case 0x0002:
      case 0x0003:
        this._image(command === 0x0003, data);
        break;
      case 0x0100:
        this._text(data);
        break;
      case 0x0102:
        this.content = { kind: 'blank' };
        break;
      case 0x0106:
        this._clockStyle(data);
        break;
      case 0x0107:
        this.powered = data[0] === 1;
        break;
      case 0x8001:
        this._setTime(data);
        break;
      default:
        break;
    }
  }

  _image(isGif, data) {
    if (data.length <= IMAGE_HEADER_BYTES) return;
    this.content = { kind: 'image', mime: isGif ? 'image/gif' : 'image/png', bytes: Buffer.from(data.subarray(IMAGE_HEADER_BYTES)) };
  }

  _setTime(data) {
    const now = new Date();
    const panel = new Date(now);
    panel.setHours(data[0] || 0, data[1] || 0, data[2] || 0, 0);
    this.clockOffsetMs = panel.getTime() - now.getTime();
  }

  _clockStyle(data) {
    this.content = { kind: 'clock', style: data[0] || 1, show24h: data[1] === 1, showDate: data[2] === 1 };
  }

  /** Rebuilds the text from its windows, then turns the per-character bitmaps into one pixel strip. */
  _text(data) {
    if (data.length <= IMAGE_HEADER_BYTES) return;
    const first = data[0] === 0x00;
    const total = data.readUInt32LE(1);
    const chunk = data.subarray(IMAGE_HEADER_BYTES);
    if (first) this.textParts = { total, chunks: [] };
    if (!this.textParts) return;
    this.textParts.chunks.push(chunk);
    const joined = Buffer.concat(this.textParts.chunks);
    if (joined.length < this.textParts.total) return;
    this.textParts = null;
    try {
      this.content = decodeText(joined);
    } catch {
      this.content = { kind: 'blank' };
    }
  }
}

const reverseBits = (byte) => {
  let out = 0;
  for (let i = 0; i < 8; i++) if (byte & (1 << i)) out |= 1 << (7 - i);
  return out;
};

const TEXT_ANIMATIONS = ['static', 'scroll-left', 'scroll-right', 'scroll-up', 'scroll-down', 'blink', 'fade', 'snowflake'];

/** The reverse of protocol/textMode.js: character count, 13 property bytes, then one bitmap block per character. */
function decodeText(buf) {
  const count = buf[0];
  const animation = TEXT_ANIMATIONS[buf[4]] || 'static';
  const speed = buf[5];
  let offset = 14;
  const cells = [];
  for (let i = 0; i < count && offset < buf.length; i++) {
    const big = (buf[offset] & 2) !== 0;
    const color = [buf[offset + 1], buf[offset + 2], buf[offset + 3]];
    const width = big ? 16 : 8;
    const height = big ? 32 : 16;
    const bytesPerRow = width / 8;
    offset += 4;
    const rows = buf.subarray(offset, offset + height * bytesPerRow);
    offset += height * bytesPerRow;
    cells.push({ width, height, color, rows });
  }
  if (!cells.length) return { kind: 'blank' };
  if (animation === 'scroll-right') cells.reverse(); // sent in reverse order for the panel's right to left drawing

  const height = cells[0].height;
  const stripWidth = cells.reduce((n, c) => n + c.width, 0);
  const rgba = Buffer.alloc(stripWidth * height * 4); // transparent where nothing is lit
  let x0 = 0;
  for (const cell of cells) {
    const bytesPerRow = cell.width / 8;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < cell.width; x++) {
        const bit = cell.width - 1 - x;
        const byte = reverseBits(cell.rows[y * bytesPerRow + (bytesPerRow - 1 - (bit >> 3))] || 0);
        if (!(byte & (1 << (bit & 7)))) continue;
        const o = (y * stripWidth + x0 + x) * 4;
        rgba[o] = cell.color[0];
        rgba[o + 1] = cell.color[1];
        rgba[o + 2] = cell.color[2];
        rgba[o + 3] = 255;
      }
    }
    x0 += cell.width;
  }
  return { kind: 'text', animation, speed, width: stripWidth, height, rgba };
}

module.exports = { VirtualPanel, EMULATED_PREFIX, isEmulatedId, decodeText };
