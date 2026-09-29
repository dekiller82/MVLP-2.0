'use strict';

/**
 * Builds assets/circuits.json, the circuit outlines used for the idle "next race" screen.
 *
 * The outlines come from bacinger/f1-circuits (MIT licensed, see THIRD_PARTY_NOTICES.md), one
 * GeoJSON file for all circuits. They are stored compactly (rounded coordinates) and matched to
 * the race calendar by location, so this is a snapshot: run it again when a new circuit is
 * added to the calendar and to the dataset.
 *
 *   npm run circuits
 */

const fs = require('fs');
const path = require('path');

const SOURCE = 'https://raw.githubusercontent.com/bacinger/f1-circuits/master/f1-circuits.geojson';
const OUT = path.join(__dirname, '..', 'assets', 'circuits.json');
const DECIMALS = 5; // about a metre, far finer than a 32 px panel needs

const round = (n) => Number(n.toFixed(DECIMALS));

(async () => {
  const res = await fetch(SOURCE, { headers: { 'User-Agent': 'MVLP-build-circuits' } });
  if (!res.ok) throw new Error(`Could not download the circuit outlines: HTTP ${res.status}`);
  const geo = await res.json();

  const circuits = geo.features.map((f) => {
    const line = f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.coordinates[0];
    const lat = line.reduce((s, p) => s + p[1], 0) / line.length;
    const lon = line.reduce((s, p) => s + p[0], 0) / line.length;
    return {
      id: f.properties.id,
      name: f.properties.Name,
      location: f.properties.Location,
      lat: round(lat),
      lon: round(lon),
      coords: line.map(([x, y]) => [round(x), round(y)]),
    };
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(circuits)}\n`);
  console.log(`Wrote ${circuits.length} circuit outlines to assets/circuits.json (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB).`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
