'use strict';

const { hexToRgb, toolkit } = require('./resultGifs');

const { newCanvas, fillRect, drawText, drawCentered, textWidth, textStyleFor, frameOf, encode, drawPodium } = toolkit;

/**
 * The idle screens: what the panel shows when no session is live and nothing is playing.
 * Each one is a short animation of two pages; the last page is held a long time so the
 * panel does not loop back before the rotation moves on.
 */

const PAGE_MS = { nextMap: 6000, nextInfo: 4000, title: 2500, podium: 7500, drivers: 5000, constructors: 5000 };
const FINAL_HOLD_MS = 30000;
const WHITE = [255, 255, 255];
const OUTLINE_GREY = [150, 150, 158];
const MEDAL_GOLD = [255, 215, 0];

// ---- text helpers ------------------------------------------------------------------------------

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** "3D 4H", "5H 30M", "45M" or "NOW"; short enough for a 32 px panel. */
function formatCountdown(msUntil, inProgress = false) {
  if (inProgress || msUntil <= 0) return 'NOW';
  const minutes = Math.floor(msUntil / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days >= 1) return `${days}D ${hours}H`;
  if (hours >= 1) return `${hours}H ${minutes % 60}M`;
  return `${Math.max(1, minutes)}M`;
}

/** "4 OCT", in the viewer's own time zone. */
function formatDate(startMs) {
  const d = new Date(startMs);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** Text centred on the canvas, white, as big as fits up to `maxScale`. */
function drawFitted(c, text, maxScale, top, rgb = WHITE, outline = null) {
  let scale = maxScale;
  while (scale > 1 && textWidth(text, scale, 1) + 2 > c.width) scale--;
  drawCentered(c, text, scale, c.width / 2, top, rgb, outline);
  return scale;
}

// ---- next race: the circuit and a countdown ------------------------------------------------------

/** Equirectangular projection of a [lon, lat] outline, north up, fitted to a region of the canvas. */
function drawOutline(c, coords, region, rgb) {
  const lat0 = coords.reduce((s, p) => s + p[1], 0) / coords.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const pts = coords.map(([lon, lat]) => ({ x: lon * k, y: -lat }));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((region.w - 1) / (maxX - minX || 1), (region.h - 1) / (maxY - minY || 1));
  const offX = region.x + (region.w - 1 - (maxX - minX) * scale) / 2 - minX * scale;
  const offY = region.y + (region.h - 1 - (maxY - minY) * scale) / 2 - minY * scale;
  const px = pts.map((p) => [Math.round(p.x * scale + offX), Math.round(p.y * scale + offY)]);

  const put = (x, y) => fillRect(c, x, y, 1, 1, rgb);
  for (let i = 0; i < px.length; i++) {
    let [x0, y0] = px[i];
    const [x1, y1] = px[(i + 1) % px.length];
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      put(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }
}

/**
 * The next race. Page 1: the circuit outline with the time to go. Page 2: the country code
 * and the date. Without an outline it is a single page of code, countdown and date.
 *
 * @param race { code, msUntil, inProgress, start }
 * @param outline [[lon, lat], ...] or null
 */
function makeNextRaceGif({ race, outline }, width, height) {
  const small = Math.max(1, Math.floor(height / 32));
  const countdown = formatCountdown(race.msUntil, race.inProgress);
  const date = formatDate(race.start);
  const frames = [];

  const codePage = () => {
    const c = newCanvas(width, height);
    drawFitted(c, race.code, 3 * small, Math.round(height * 0.16), MEDAL_GOLD);
    drawFitted(c, date, small, Math.round(height * 0.66));
    return c;
  };

  if (outline) {
    const a = newCanvas(width, height);
    const margin = 2 * small;
    drawOutline(a, outline, { x: margin, y: margin, w: width - 2 * margin, h: Math.round(height * 0.68) }, OUTLINE_GREY);
    drawFitted(a, countdown, small, height - 5 * small - Math.round(height * 0.1));
    frames.push(frameOf(a, PAGE_MS.nextMap));
    frames.push(frameOf(codePage(), FINAL_HOLD_MS));
  } else {
    const c = newCanvas(width, height);
    drawFitted(c, race.code, 3 * small, small, MEDAL_GOLD);
    drawFitted(c, countdown, small, 18 * small, OUTLINE_GREY);
    drawFitted(c, date, small, 25 * small);
    frames.push(frameOf(c, FINAL_HOLD_MS));
  }
  return encode(width, height, frames);
}

// ---- last race: the podium ----------------------------------------------------------------------

/** Page 1: "LAST" and the race's country code. Page 2: the podium. */
function makeLastPodiumGif({ code, podium }, width, height) {
  const small = Math.max(1, Math.floor(height / 32));
  const title = newCanvas(width, height);
  drawFitted(title, 'LAST', small, Math.round(height * 0.16), OUTLINE_GREY);
  drawFitted(title, code, 3 * small, Math.round(height * 0.4), MEDAL_GOLD);

  const page = newCanvas(width, height);
  drawPodium(page, podium, width, height);
  return encode(width, height, [frameOf(title, PAGE_MS.title), frameOf(page, FINAL_HOLD_MS)]);
}

// ---- standings ---------------------------------------------------------------------------------------

/** Three rows: a team-colour block with the position, the code, the points on the right. */
function drawStandingsPage(rows, width, height) {
  const c = newCanvas(width, height);
  const small = Math.max(1, Math.floor(height / 32));
  const rowHeight = Math.floor((height - 2) / 3);
  const style = textStyleFor();
  rows.slice(0, 3).forEach((row, i) => {
    const top = 1 + i * rowHeight;
    const textTop = top + Math.floor((rowHeight - 1 - 5 * small) / 2);
    const blockWidth = 3 * small + 2; // the digit with a pixel of team colour on each side
    fillRect(c, 0, top, blockWidth, rowHeight - 1, hexToRgb(row.color));
    drawCentered(c, String(row.position), small, blockWidth / 2, textTop, style.fg, style.outline, { x: 0, w: blockWidth });
    drawText(c, row.code, small, blockWidth + 2, textTop, WHITE);
    const points = String(row.points);
    drawText(c, points, small, width - textWidth(points, small, small) - 1, textTop, MEDAL_GOLD);
  });
  return c;
}

/** Page 1: the top three drivers. Page 2: the top three teams. */
function makeStandingsGif({ drivers, constructors }, width, height) {
  const pages = [];
  if (drivers?.length) pages.push({ canvas: drawStandingsPage(drivers, width, height), ms: PAGE_MS.drivers });
  if (constructors?.length) pages.push({ canvas: drawStandingsPage(constructors, width, height), ms: PAGE_MS.constructors });
  const frames = pages.map((p, i) => frameOf(p.canvas, i === pages.length - 1 ? FINAL_HOLD_MS : p.ms));
  return encode(width, height, frames);
}

module.exports = { makeNextRaceGif, makeLastPodiumGif, makeStandingsGif, formatCountdown, formatDate };
