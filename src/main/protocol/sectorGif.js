'use strict';

const { GifWriter } = require('omggif');

// 3x5 pixel digits, one string per row ('#' = pixel set).
const FONT = {
  0: ['###', '#.#', '#.#', '#.#', '###'],
  1: ['.#.', '##.', '.#.', '.#.', '###'],
  2: ['###', '..#', '###', '#..', '###'],
  3: ['###', '..#', '###', '..#', '###'],
  4: ['#.#', '#.#', '###', '..#', '..#'],
  5: ['###', '#..', '###', '..#', '###'],
  6: ['###', '#..', '###', '#.#', '###'],
  7: ['###', '..#', '.#.', '.#.', '.#.'],
  8: ['###', '#.#', '###', '#.#', '###'],
  9: ['###', '#.#', '###', '..#', '###'],
};

const YELLOW = 0xffff00;
const BLACK = 0x000000;
const FRAME_DELAY_CS = 25; // matches the bundled yellow.gif (250 ms per frame)
const FAST_FRAME_DELAY_CS = 18; // double yellow flashes faster than a single yellow, but not a strobe

/** Pixel mask (Uint8Array, 1 = digit pixel) with the number centred and scaled to fit. */
function renderNumberMask(number, width, height) {
  const digits = String(number).split('');
  const glyphW = digits.length * 3 + (digits.length - 1); // 1 column gap between digits
  const scale = Math.max(1, Math.min(Math.floor((width - 2) / glyphW), Math.floor((height - 2) / 5)));
  const drawW = glyphW * scale;
  const drawH = 5 * scale;
  const originX = Math.floor((width - drawW) / 2);
  const originY = Math.floor((height - drawH) / 2);

  const mask = new Uint8Array(width * height);
  digits.forEach((digit, di) => {
    const glyph = FONT[digit];
    if (!glyph) return;
    const gx = originX + di * 4 * scale;
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (glyph[row][col] !== '#') continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            mask[(originY + row * scale + dy) * width + gx + col * scale + dx] = 1;
          }
        }
      }
    }
  });
  return mask;
}

/**
 * Yellow-flag animation for one track sector: frame 1 is a yellow box with the
 * sector number cut out in "off" (black) pixels, frame 2 is all black, so it
 * flashes like yellow.gif. The first frame doubles as the still it settles on.
 */
function makeSectorYellowGif(sector, width, height, { fast = false } = {}) {
  const delay = fast ? FAST_FRAME_DELAY_CS : FRAME_DELAY_CS;
  const mask = renderNumberMask(sector, width, height);
  const numbered = new Uint8Array(width * height);
  for (let i = 0; i < numbered.length; i++) numbered[i] = mask[i] ? 1 : 0; // 0 = yellow, 1 = black
  const blank = new Uint8Array(width * height).fill(1);

  const buf = new Uint8Array(width * height * 2 + 1024);
  const writer = new GifWriter(buf, width, height, { loop: 0, palette: [YELLOW, BLACK] });
  writer.addFrame(0, 0, width, height, numbered, { delay, disposal: 1 });
  writer.addFrame(0, 0, width, height, blank, { delay, disposal: 1 });
  return Buffer.from(buf.buffer, 0, writer.end());
}

module.exports = { makeSectorYellowGif, renderNumberMask };
