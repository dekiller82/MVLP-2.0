'use strict';

const { GifWriter } = require('omggif');

const { GLYPHS, textUnits, fitScale } = require('./font');

// Palette indices.
const BLACK = 0;
const WHITE = 1;
const AMBER = 2;
const GREEN = 3;
const TRACK = 4;
const LABEL = 5;
const PALETTE = [0x000000, 0xffffff, 0xffa000, 0x00c800, 0x303030, 0x40a0ff, 0x000000, 0x000000];

function drawText(px, width, text, scale, top, color) {
  const left = Math.floor((width - textUnits(text) * scale) / 2);
  [...text].forEach((ch, i) => {
    const glyph = GLYPHS[ch];
    if (!glyph) return;
    const gx = left + i * 4 * scale;
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (glyph[row][col] !== '#') continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) px[(top + row * scale + dy) * width + gx + col * scale + dx] = color;
        }
      }
    }
  });
}

/** Amber hourglass centred in the given band. */
function drawHourglass(px, width, top, bandHeight, color) {
  const h = bandHeight;
  const w = Math.max(5, Math.round(h * 0.7));
  const left = Math.floor((width - w) / 2);
  const mid = (h - 1) / 2;
  for (let y = 0; y < h; y++) {
    const isBar = y === 0 || y === h - 1;
    const half = isBar ? w / 2 : Math.max(0.5, ((w / 2) * Math.abs(y - mid)) / mid);
    const from = Math.round(left + w / 2 - half);
    const to = Math.round(left + w / 2 + half);
    for (let x = from; x < to; x++) px[(top + y) * width + x] = color;
  }
}

/** What the panel shows for `remainingMs` to go (null = delayed with no new time). */
function viewFor(label, remainingMs, progress) {
  if (remainingMs === null) return { label, mode: 'delayed', value: 0, progress: 0 };
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const fill = Math.max(0, Math.min(1, progress));
  if (seconds < 60) return { label, mode: 'seconds', value: seconds, progress: fill };
  const minutes = Math.ceil(seconds / 60);
  if (minutes > 99) return { label, mode: 'hours', value: Math.ceil(minutes / 60), progress: fill };
  return { label, mode: 'minutes', value: minutes, progress: fill };
}

/**
 * Pre-session screen: session label on top, the time to start in the middle,
 * a progress bar along the bottom. Returns palette indices, one per pixel.
 *
 * @param state.label    "Q1", "P2", ...
 * @param state.mode     'minutes' | 'hours' | 'seconds' | 'delayed'
 * @param state.value    number shown (minutes, hours or seconds); unused for 'delayed'
 * @param state.progress 0..1 fill of the bottom bar (elapsed share of the wait)
 */
function renderFrame(state, width, height) {
  const px = new Uint8Array(width * height).fill(BLACK);
  const unit = Math.max(1, Math.floor(Math.min(width, height) / 32));

  const labelScale = fitScale(state.label, width, 2 * unit);
  const labelTop = unit;
  const labelBottom = labelTop + 5 * labelScale;
  drawText(px, width, state.label, labelScale, labelTop, LABEL);

  const barHeight = 2 * unit;
  const barTop = height - barHeight - unit;
  const bandTop = labelBottom + 2 * unit;
  const bandHeight = barTop - unit - bandTop;
  const amber = state.mode === 'seconds' || state.mode === 'delayed';

  if (state.mode === 'delayed') {
    drawHourglass(px, width, bandTop, bandHeight, AMBER);
  } else {
    const text = `${state.value}${state.mode === 'hours' ? 'H' : ''}`;
    const scale = fitScale(text, width, Math.max(1, Math.floor(bandHeight / 5)));
    drawText(px, width, text, scale, bandTop + Math.floor((bandHeight - 5 * scale) / 2), amber ? AMBER : WHITE);
  }

  if (state.mode !== 'delayed') {
    const barLeft = 2 * unit;
    const barWidth = width - 4 * unit;
    const fill = Math.floor(Math.max(0, Math.min(1, state.progress)) * barWidth + 1e-6);
    for (let y = barTop; y < barTop + barHeight; y++) {
      for (let x = 0; x < barWidth; x++) px[y * width + barLeft + x] = x < fill ? (amber ? AMBER : GREEN) : TRACK;
    }
  }
  return px;
}

const MAX_DELAY_CS = 65000; // GIF frame delays are 16-bit centiseconds (~650 s)
const FINAL_HOLD_CS = 3000; // how long the final "0" frame stays before a player might loop

/** A single still frame. */
function makeCountdownGif(state, width, height) {
  const buf = new Uint8Array(width * height + 1024);
  const writer = new GifWriter(buf, width, height, { palette: PALETTE });
  writer.addFrame(0, 0, width, height, renderFrame(state, width, height), { delay: 100, disposal: 1 });
  return Buffer.from(buf.buffer, 0, writer.end());
}

/**
 * An animation that runs the countdown by itself: one frame per change in what
 * is shown (each second in the last minute, each minute before that, plus the
 * progress bar steps), timed so that it reaches zero `startRemainingMs` after
 * it starts playing. Meant for short spans (the last minute or so): the panel
 * only ever runs frames that last a few seconds at most. Built at send time,
 * so it works from any point in the countdown.
 *
 * @param opts.label            session label
 * @param opts.startRemainingMs time left when the animation starts playing
 * @param opts.totalMs          length of the whole wait, for the progress bar
 */
function makeCountdownAnimation({ label, startRemainingMs, totalMs }, width, height) {
  const total = Math.max(totalMs, startRemainingMs, 1);
  // Bar steps: at most 30 (15 for long waits, to keep the file small). For short
  // waits use one step per second, so the bar moves together with the digits
  // instead of doubling the frame count.
  const barSteps = Math.max(5, Math.min(total > 20 * 60000 ? 15 : 30, Math.round(total / 1000)));
  const viewAt = (remaining) => viewFor(label, remaining, 1 - remaining / total);
  const keyOf = (v) => `${v.mode}|${v.value}|${Math.floor(v.progress * barSteps + 1e-6)}`;

  // Walk the countdown on a 100 ms grid and cut a frame wherever the picture changes.
  const frames = [];
  let current = viewAt(startRemainingMs);
  let currentKey = keyOf(current);
  let startedAt = 0;
  for (let elapsed = 100; elapsed <= startRemainingMs; elapsed += 100) {
    const view = viewAt(startRemainingMs - elapsed);
    const key = keyOf(view);
    if (key !== currentKey) {
      frames.push({ view: current, ms: elapsed - startedAt });
      current = view;
      currentKey = key;
      startedAt = elapsed;
    }
  }
  frames.push({ view: current, ms: startRemainingMs - startedAt });
  frames.push({ view: viewAt(0), ms: 0 }); // zero, held until replaced

  const buf = new Uint8Array(width * height * (frames.length + 4) + 2048);
  const writer = new GifWriter(buf, width, height, { palette: PALETTE });
  frames.forEach((f, i) => {
    const pixels = renderFrame(f.view, width, height);
    let cs = i === frames.length - 1 ? FINAL_HOLD_CS : Math.max(2, Math.round(f.ms / 10));
    // Split very long holds into several frames so no delay overflows.
    while (cs > MAX_DELAY_CS) {
      writer.addFrame(0, 0, width, height, pixels, { delay: MAX_DELAY_CS, disposal: 1 });
      cs -= MAX_DELAY_CS;
    }
    writer.addFrame(0, 0, width, height, pixels, { delay: cs, disposal: 1 });
  });
  return { gif: Buffer.from(buf.buffer, 0, writer.end()), frames: frames.length };
}

module.exports = { makeCountdownGif, makeCountdownAnimation, viewFor };
