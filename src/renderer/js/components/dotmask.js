'use strict';

// The emulated panel's dot mask: a shape (the pixel style) plus four adjustable numbers, shared by the
// emulator window (which draws it) and the Devices page (which edits it).

export const PIXEL_STYLES = [['round', 'Round LEDs'], ['square', 'Square LEDs'], ['flat', 'Flat pixels']];

/** What each style starts with. dotSize and softness are % of one pixel's cell, maskStrength and boost are %. */
export const DOT_DEFAULTS = {
  round: { dotSize: 100, softness: 18, maskStrength: 90, boost: 125 },
  square: { dotSize: 90, softness: 0, maskStrength: 90, boost: 125 },
  flat: { dotSize: 100, softness: 0, maskStrength: 0, boost: 100 },
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** A panel's saved config with the style's defaults filled in for anything not set. */
export function resolveDots(config) {
  const style = DOT_DEFAULTS[config.pixelStyle] ? config.pixelStyle : 'round';
  const d = { ...DOT_DEFAULTS[style] };
  for (const key of Object.keys(d)) if (typeof config[key] === 'number' && !Number.isNaN(config[key])) d[key] = config[key];
  return { style, ...d };
}

/** The CSS background-image that darkens the gaps between the lit dots. */
export function maskImage(d) {
  if (d.style === 'flat' || d.maskStrength <= 0) return 'none';
  const alpha = clamp(d.maskStrength, 0, 100) / 100;
  const size = d.style === 'square' ? Math.min(d.dotSize, 100) : d.dotSize;
  const outer = clamp(size, 5, 200);
  const inner = outer * (1 - clamp(d.softness, 0, 100) / 100);
  const dark = `rgba(0, 0, 0, ${alpha})`;
  if (d.style === 'round') return `radial-gradient(circle closest-side, transparent ${inner}%, ${dark} ${outer}%)`;
  return `linear-gradient(to right, transparent ${inner}%, ${dark} ${outer}%), linear-gradient(to bottom, transparent ${inner}%, ${dark} ${outer}%)`;
}
