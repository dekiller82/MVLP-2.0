'use strict';

/**
 * Renders the README preview images into docs/previews/.
 *
 * The effects are drawn by the app's own generators at the panel's real 32x32
 * resolution, then enlarged with nearest-neighbour scaling so individual LEDs stay
 * crisp. Only the track map needs the network (the circuit outline comes from
 * Multiviewer's public circuit API).
 *
 *   npm run previews
 */

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

const image = require('../src/main/protocol/image');
const { makeSectorYellowGif } = require('../src/main/protocol/sectorGif');
const { makeYellowMap } = require('../src/main/protocol/trackMapGif');
const { makeGreenBorderGif, makeFastestLapGif, makeStartupGif } = require('../src/main/protocol/effectGifs');
const { makeCountdownGif, makeCountdownAnimation, viewFor } = require('../src/main/protocol/countdownGif');

const OUT = path.join(__dirname, '..', 'docs', 'previews');
const GIFS = path.join(__dirname, '..', 'assets', 'gifs');
const PANEL = 32;
const SCALE = 4; // 32 px panel -> 128 px preview
const MAX_HOLD_MS = 1200; // long holds are shortened so the previews loop nicely

const CIRCUIT_API = 'https://api.multiviewer.app/api/v1/circuits';

function upscale(rgba, size, scale) {
  const big = size * scale;
  const out = new Uint8ClampedArray(big * big * 4);
  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const src = ((Math.floor(y / scale) * size) + Math.floor(x / scale)) * 4;
      const dst = (y * big + x) * 4;
      out[dst] = rgba[src]; out[dst + 1] = rgba[src + 1]; out[dst + 2] = rgba[src + 2]; out[dst + 3] = 255;
    }
  }
  return out;
}

/** Writes an animated preview from a GIF buffer produced by one of the generators. */
function saveAnimation(name, gifBuffer) {
  const decoded = image.decodeGifToRgbaFrames(gifBuffer);
  const frames = decoded.frames.map((f) => ({ data: upscale(f.data, decoded.width, SCALE), delay: Math.min(f.delay, MAX_HOLD_MS) }));
  const out = image.encodeGif(decoded.width * SCALE, decoded.height * SCALE, frames, { loop: 0 });
  fs.writeFileSync(path.join(OUT, `${name}.gif`), out);
  console.log(`  ${name}.gif  ${frames.length} frames, ${(out.length / 1024).toFixed(0)} KB`);
}

/** Writes a still preview (PNG) laid out as a grid of RGBA panel frames. */
async function saveSheet(name, tiles, columns, gap = 6) {
  const big = PANEL * SCALE;
  const rows = Math.ceil(tiles.length / columns);
  const sheet = new Jimp(columns * (big + gap) + gap, rows * (big + gap) + gap, 0x111318ff);
  tiles.forEach((rgba, i) => {
    const tile = new Jimp({ data: Buffer.from(upscale(rgba, PANEL, SCALE)), width: big, height: big });
    sheet.composite(tile, gap + (i % columns) * (big + gap), gap + Math.floor(i / columns) * (big + gap));
  });
  await sheet.writeAsync(path.join(OUT, `${name}.png`));
  console.log(`  ${name}.png  ${tiles.length} panels`);
}

const firstFrame = (gif) => image.decodeGifToRgbaFrames(gif).frames[0].data;

async function loadCircuit(key) {
  const res = await fetch(`${CIRCUIT_API}/${key}/2026`, { headers: { 'User-Agent': 'MVLP-previews' } });
  if (!res.ok) throw new Error(`Circuit ${key}: HTTP ${res.status}`);
  const c = await res.json();
  return {
    name: c.circuitName,
    circuit: { x: c.x, y: c.y, rotation: c.rotation, marshal: c.marshalSectors.map((m) => ({ number: m.number, length: m.length })) },
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('Rendering previews into docs/previews/');

  // Yellow flag with the sector number cut out of the yellow.
  saveAnimation('yellow-sector', makeSectorYellowGif(14, PANEL, PANEL));
  saveAnimation('yellow-sector-double', makeSectorYellowGif(14, PANEL, PANEL, { fast: true }));

  // Every sector number the panel can show, as a still sheet.
  const numbers = [];
  for (let n = 1; n <= 24; n++) numbers.push(firstFrame(makeSectorYellowGif(n, PANEL, PANEL)));
  await saveSheet('sector-numbers', numbers, 8);

  // Yellow flag track map: big flashes, then the flagged line keeps flashing.
  const miami = await loadCircuit(151);
  const baku = await loadCircuit(144);
  const map = makeYellowMap(miami.circuit, [4, 5], PANEL, PANEL);
  saveAnimation('yellow-map', map.gif);
  saveAnimation('yellow-map-double', makeYellowMap(miami.circuit, [4, 5], PANEL, PANEL, { fast: true }).gif);
  await saveSheet('track-maps', [
    firstFrame(makeYellowMap(miami.circuit, [4, 5], PANEL, PANEL).loop),
    firstFrame(makeYellowMap(miami.circuit, [12], PANEL, PANEL).loop),
    firstFrame(makeYellowMap(baku.circuit, [8, 9], PANEL, PANEL).loop),
    firstFrame(makeYellowMap(baku.circuit, [15, 16, 17], PANEL, PANEL).loop),
  ], 4);

  // Safety car / VSC ending: the bundled artwork with a pulsing green border.
  saveAnimation('sc-ending', await makeGreenBorderGif(path.join(GIFS, 'sc.gif'), PANEL, PANEL));
  saveAnimation('vsc-ending', await makeGreenBorderGif(path.join(GIFS, 'vsc.gif'), PANEL, PANEL));

  // Fastest lap: solid purple.
  await saveSheet('fastest-lap', [firstFrame(makeFastestLapGif(PANEL, PANEL))], 1);

  // Session countdown: a 12 second run, plus the still variants.
  saveAnimation('countdown', makeCountdownAnimation({ label: 'Q1', startRemainingMs: 12000, totalMs: 12000 }, PANEL, PANEL).gif);
  await saveSheet('countdown-states', [
    firstFrame(makeCountdownGif(viewFor('Q1', 12 * 60000, 0.4), PANEL, PANEL)),
    firstFrame(makeCountdownGif(viewFor('P2', 4 * 60000, 0.85), PANEL, PANEL)),
    firstFrame(makeCountdownGif(viewFor('SQ1', 38000, 0.9), PANEL, PANEL)),
    firstFrame(makeCountdownGif(viewFor('Q3', 3 * 3600000, 0), PANEL, PANEL)),
    firstFrame(makeCountdownGif(viewFor('Q1', null, 0), PANEL, PANEL)),
  ], 5);

  // Startup animation.
  saveAnimation('startup', await makeStartupGif(path.join(GIFS, 'mv.gif'), PANEL, PANEL));

  console.log('Done.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
