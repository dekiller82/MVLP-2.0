'use strict';

const { makePayload } = require('./common');
const { crc32 } = require('./crc32');
const { GLYPHS } = require('./font');

/**
 * The panel's own text mode (command 0x0100), as used by pypixelcolor. The panel does the scrolling
 * itself: it is sent one bitmap per character (a fixed-width cell as tall as the panel or half of it),
 * plus the colour, animation and speed. Glyphs here come from the app's own 3x5 font, scaled up.
 *
 * Layout of the data, after the command:
 *   option (0 first window, 2 after) | total size u32 | crc32 u32 | 0x00 | save slot | chunk
 * and the chunks joined form:  character count | 13 property bytes | one block per character
 * with a block being:  opcode | r g b | bitmap rows (big endian, bits reversed within each byte).
 */

const ANIMATIONS = { static: 0, 'scroll-left': 1, 'scroll-right': 2, 'scroll-up': 3, 'scroll-down': 4, blink: 5, fade: 6, snowflake: 7 };
const WINDOW_BYTES = 12 * 1024;

const reverseBits = (byte) => {
  let out = 0;
  for (let i = 0; i < 8; i++) if (byte & (1 << i)) out |= 1 << (7 - i);
  return out;
};

/** One character as a bitmap block: `cellHeight` rows in a cell that is half as wide as it is tall. */
function characterBlock(char, cellHeight, color) {
  const big = cellHeight >= 32;
  const cellWidth = big ? 16 : 8;
  const scale = big ? 4 : 2;
  const glyph = GLYPHS[char];
  const top = Math.floor((cellHeight - 5 * scale) / 2);
  const left = big ? 2 : 1;
  const bytesPerRow = cellWidth / 8;
  const rows = Buffer.alloc(cellHeight * bytesPerRow);
  if (glyph) {
    for (let gy = 0; gy < 5; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        if (glyph[gy][gx] !== '#') continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const x = left + gx * scale + dx;
            const y = top + gy * scale + dy;
            const bit = cellWidth - 1 - x; // leftmost pixel is the most significant bit
            rows[y * bytesPerRow + (bytesPerRow - 1 - (bit >> 3))] |= 1 << (bit & 7);
          }
        }
      }
    }
  }
  const bitmap = Buffer.from(rows.map(reverseBits));
  return Buffer.concat([Buffer.from([(big ? 2 : 0) | 0, color[0], color[1], color[2]]), bitmap]);
}

/**
 * @param text       what to show (upper case letters and digits; anything else is a blank)
 * @param opts.height    32 for full-height characters, 16 for half-height
 * @param opts.animation a key of ANIMATIONS
 * @param opts.speed     0 to 100
 * @param opts.color     [r, g, b]
 * @returns the payloads to write to the panel
 */
function makeTextPayloads(text, { height = 32, animation = 'scroll-left', speed = 80, color = [255, 255, 255], rainbow = 0, slot = 0 } = {}) {
  const chars = String(text).toUpperCase().slice(0, 100).split('');
  if (!chars.length) throw new Error('There is no text to send.');
  if (!(animation in ANIMATIONS)) throw new Error(`Unknown text animation "${animation}".`);
  const rtl = animation === 'scroll-right'; // the panel draws right to left, so the order is reversed
  const ordered = rtl ? chars.reverse() : chars;

  const properties = Buffer.from([0x00, 0x01, 0x01, ANIMATIONS[animation], speed & 0xff, rainbow & 0xff, ...color, 0x00, 0x00, 0x00, 0x00]);
  const blocks = ordered.map((c) => characterBlock(c, height, color));
  const data = Buffer.concat([Buffer.from([ordered.length]), properties, ...blocks]);

  const crc = crc32(data);
  const payloads = [];
  for (let pos = 0, index = 0; pos < data.length; pos += WINDOW_BYTES, index++) {
    const header = Buffer.alloc(11);
    header[0] = index === 0 ? 0x00 : 0x02;
    header.writeUInt32LE(data.length, 1);
    header.writeUInt32LE(crc, 5);
    header[9] = 0x00;
    header[10] = slot & 0xff;
    payloads.push(makePayload(0x0100, Buffer.concat([header, data.subarray(pos, pos + WINDOW_BYTES)])));
  }
  return payloads;
}

module.exports = { makeTextPayloads, ANIMATIONS };
