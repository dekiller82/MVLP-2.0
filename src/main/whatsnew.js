'use strict';

const fs = require('fs');
const path = require('path');

const { isNewer } = require('./updater');

const CHANGELOG = path.join(__dirname, '..', '..', 'CHANGELOG.md');

/**
 * Parses CHANGELOG.md into [{ version, date, intro, sections: [{ title, items }] }], newest first.
 * The format is `## 2.0.3 (2026-09-30)`, an optional line of text, then `### Section` headings
 * with `- bullet` lines. Anything else is ignored.
 */
function parseChangelog(text) {
  const entries = [];
  let entry = null;
  let section = null;
  for (const line of String(text).split(/\r?\n/)) {
    const h2 = /^##\s+(\d+\.\d+\.\d+(?:-[\w.]+)?)\s*(?:\((.*?)\))?\s*$/.exec(line);
    if (h2) {
      entry = { version: h2[1], date: h2[2] || '', intro: '', sections: [] };
      entries.push(entry);
      section = null;
      continue;
    }
    if (!entry) continue;
    const h3 = /^###\s+(.*\S)\s*$/.exec(line);
    if (h3) {
      section = { title: h3[1], items: [] };
      entry.sections.push(section);
    } else if (/^\s*-\s+/.test(line) && section) {
      section.items.push(line.replace(/^\s*-\s+/, '').trim());
    } else if (line.trim() && !section) {
      entry.intro = entry.intro ? `${entry.intro} ${line.trim()}` : line.trim();
    }
  }
  return entries;
}

function readEntries() {
  try {
    return parseChangelog(fs.readFileSync(CHANGELOG, 'utf8'));
  } catch {
    return [];
  }
}

/** Entries newer than `lastSeen` up to and including `current` (nothing for a first run or when `lastSeen` is empty). */
function entriesSince(entries, lastSeen, current) {
  if (!lastSeen) return [];
  return entries.filter((e) => isNewer(e.version, lastSeen) && !isNewer(e.version, current));
}

/** The newest entries up to `current`, for the What's new button. */
function latestEntries(entries, current, count = 3) {
  return entries.filter((e) => !isNewer(e.version, current)).slice(0, count);
}

module.exports = { parseChangelog, readEntries, entriesSince, latestEntries };
