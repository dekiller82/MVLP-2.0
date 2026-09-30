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
const { makeGridWalkGif, makeWinnerGif, makePodiumGif, makePoleGif } = require('../src/main/protocol/resultGifs');
const { makeNextRaceGif, makeScheduleGif, makeLastPodiumGif, makeStandingsGif } = require('../src/main/protocol/idleScreens');
const CIRCUITS = require('../assets/circuits.json');

const OUT = path.join(__dirname, '..', 'docs', 'previews');
const GIFS = path.join(__dirname, '..', 'assets', 'gifs');
const PANEL = 32;
const SCALE = 4; // 32 px panel -> 128 px preview
const MAX_HOLD_MS = 1200; // long holds are shortened so the previews loop nicely

const CIRCUIT_API = 'https://api.multiviewer.app/api/v1/circuits';

// A sample running order (number, code and team colour, as Multiviewer reports them), so
// the driver screens can be previewed without a session loaded.
const SAMPLE_GRID = [
  { number: '63', tla: 'RUS', color: '00D7B6' },
  { number: '81', tla: 'PIA', color: 'F47600' },
  { number: '44', tla: 'HAM', color: 'ED1131' },
  { number: '1', tla: 'NOR', color: 'F47600' },
  { number: '12', tla: 'ANT', color: '00D7B6' },
  { number: '10', tla: 'GAS', color: '00A1E8' },
  { number: '3', tla: 'VER', color: '4781D7' },
  { number: '41', tla: 'LIN', color: '6C98FF' },
  { number: '22', tla: 'TSU', color: '6C98FF' },
  { number: '43', tla: 'COL', color: '00A1E8' },
  { number: '5', tla: 'BOR', color: 'F50537' },
  { number: '87', tla: 'BEA', color: '9C9FA2' },
  { number: '23', tla: 'ALB', color: '1868DB' },
  { number: '27', tla: 'HUL', color: 'F50537' },
  { number: '55', tla: 'SAI', color: '1868DB' },
  { number: '31', tla: 'OCO', color: '9C9FA2' },
  { number: '30', tla: 'LAW', color: '4781D7' },
  { number: '11', tla: 'PER', color: '909090' },
  { number: '77', tla: 'BOT', color: '909090' },
  { number: '18', tla: 'STR', color: '229971' },
  { number: '14', tla: 'ALO', color: '229971' },
  { number: '16', tla: 'LEC', color: 'ED1131' },
].map((d, i) => ({ ...d, position: i + 1 }));

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

  // Driver screens: the grid walkthrough, winner, podium and pole position.
  saveAnimation('grid-walk', makeGridWalkGif(SAMPLE_GRID.slice(0, 8), PANEL, PANEL));
  const gridFrames = image.decodeGifToRgbaFrames(makeGridWalkGif(SAMPLE_GRID, PANEL, PANEL)).frames;
  await saveSheet('grid-screens', gridFrames.filter((_, i) => i % 4 === 0).map((f) => f.data), 6);
  saveAnimation('winner', makeWinnerGif(SAMPLE_GRID[0], PANEL, PANEL));
  saveAnimation('pole', makePoleGif(SAMPLE_GRID[0], PANEL, PANEL));
  await saveSheet('podium', [firstFrame(makePodiumGif(SAMPLE_GRID.slice(0, 3), PANEL, PANEL))], 1);

  // Idle screens: sample data, so no network is needed.
  const monza = CIRCUITS.find((c) => /monza/i.test(c.name + c.location));
  const race = { code: 'ITA', msUntil: (4 * 24 + 7) * 3600000, inProgress: false, start: Date.UTC(2026, 8, 6, 13) };
  saveAnimation('idle-next', makeNextRaceGif({ race, outline: monza.coords }, PANEL, PANEL));
  const at = (day, h, m) => new Date(2026, 9, day, h, m).getTime(); // times are shown in the local time zone
  saveAnimation('idle-schedule', makeScheduleGif({
    sessions: [{ label: 'P1', start: at(2, 12, 30) }, { label: 'P2', start: at(2, 16, 0) }, { label: 'P3', start: at(3, 11, 30) }, { label: 'Q', start: at(3, 15, 0) }, { label: 'R', start: at(4, 15, 0) }],
    now: at(1, 9, 0),
  }, PANEL, PANEL));
  saveAnimation('idle-podium', makeLastPodiumGif({
    code: 'JPN',
    podium: [
      { position: 1, tla: 'ANT', number: '12', color: '00D7B6' },
      { position: 2, tla: 'PIA', number: '81', color: 'F47600' },
      { position: 3, tla: 'LEC', number: '16', color: 'ED1131' },
    ],
  }, PANEL, PANEL));
  saveAnimation('idle-standings', makeStandingsGif({
    drivers: [
      { position: 1, code: 'ANT', points: 302, color: '00D7B6' },
      { position: 2, code: 'RUS', points: 236, color: '00D7B6' },
      { position: 3, code: 'HAM', points: 199, color: 'ED1131' },
    ],
    constructors: [
      { position: 1, code: 'MER', points: 538, color: '00D7B6' },
      { position: 2, code: 'FER', points: 378, color: 'ED1131' },
      { position: 3, code: 'MCL', points: 306, color: 'F47600' },
    ],
  }, PANEL, PANEL));

  console.log('Done.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
