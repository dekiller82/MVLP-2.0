'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Data for the idle screens (the panel when no session is live and nothing is playing):
 * the race calendar, the last race's podium and the championship standings.
 *
 * It comes from the free Jolpica F1 API (the community successor to Ergast). Everything is
 * cached on disk and only refreshed when stale, so a running app makes a handful of requests
 * a day; failures back off (15 s, 1 min, then every 5 min) and the stale copy keeps being
 * used meanwhile, so the screens still work offline.
 */

const API = 'https://api.jolpi.ca/ergast/f1';
const HOUR = 3600000;
const TTL_MS = { calendar: 12 * HOUR, results: 6 * HOUR, drivers: 6 * HOUR, constructors: 6 * HOUR };
const RETRY_STEPS_MS = [15000, 60000, 300000];
const RETRY_JITTER = 0.2;
const RACE_LENGTH_MS = 3 * HOUR; // a race counts as still "on" this long after it starts
const MATCH_RADIUS_KM = 10;
const CALENDAR_VERSION = 2; // 2 added the weekend's session times; an older cached calendar is refetched

// The sessions Jolpica lists for a weekend, with the short labels the panel shows.
const SESSION_KEYS = [['FirstPractice', 'P1'], ['SecondPractice', 'P2'], ['ThirdPractice', 'P3'], ['SprintQualifying', 'SQ'], ['Sprint', 'SP'], ['Qualifying', 'Q']]; 

// Team colours as Multiviewer reports them (the same colours the driver screens use).
const TEAM_COLORS = {
  mercedes: '00D7B6', ferrari: 'ED1131', mclaren: 'F47600', red_bull: '4781D7', rb: '6C98FF',
  alpine: '00A1E8', aston_martin: '229971', williams: '1868DB', haas: '9C9FA2', audi: 'F50537', cadillac: '909090',
};
const TEAM_CODES = {
  mercedes: 'MER', ferrari: 'FER', mclaren: 'MCL', red_bull: 'RBR', rb: 'RCB',
  alpine: 'ALP', aston_martin: 'AMR', williams: 'WIL', haas: 'HAA', audi: 'AUD', cadillac: 'CAD',
};
const COUNTRY_CODES = {
  Australia: 'AUS', Austria: 'AUT', Azerbaijan: 'AZE', Bahrain: 'BHR', Belgium: 'BEL', Brazil: 'BRA', Canada: 'CAN',
  China: 'CHN', France: 'FRA', Germany: 'GER', Hungary: 'HUN', India: 'IND', Italy: 'ITA', Japan: 'JPN', Korea: 'KOR',
  Malaysia: 'MAS', Mexico: 'MEX', Monaco: 'MON', Netherlands: 'NED', Portugal: 'POR', Qatar: 'QAT', Russia: 'RUS',
  'Saudi Arabia': 'KSA', Singapore: 'SGP', 'South Africa': 'RSA', 'South Korea': 'KOR', Spain: 'ESP', Turkey: 'TUR',
  UAE: 'UAE', 'United Arab Emirates': 'UAE', UK: 'GBR', 'United Kingdom': 'GBR', USA: 'USA', 'United States': 'USA',
  Argentina: 'ARG', Sweden: 'SWE', Switzerland: 'SUI', Morocco: 'MAR', Vietnam: 'VIE', Finland: 'FIN',
};

const teamColor = (constructorId) => TEAM_COLORS[constructorId] || '909090';
const teamCode = (constructorId, name = '') => TEAM_CODES[constructorId] || (String(name || constructorId).replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || '???');
const countryCode = (country) => COUNTRY_CODES[country] || (String(country || '').replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || '???');

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

class IdleData {
  /**
   * @param opts.cachePath file the fetched data is kept in
   * @param opts.circuits  outline snapshot ([{ id, lat, lon, coords }]), see scripts/build-circuits.js
   * @param opts.fetch     fetch implementation (for tests)
   * @param opts.now       clock (for tests)
   */
  constructor({ cachePath, circuits = [], fetch: fetchFn = (...a) => fetch(...a), now = () => Date.now() } = {}) {
    this.cachePath = cachePath;
    this.circuits = circuits;
    this._fetch = fetchFn;
    this._now = now;
    this.data = { calendar: null, results: null, drivers: null, constructors: null };
    this.failures = {}; // resource -> { count, retryAt }
    this.refreshing = null;
    this._load();
  }

  _load() {
    if (!this.cachePath) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      for (const key of Object.keys(this.data)) if (saved[key]) this.data[key] = saved[key];
    } catch { /* no cache yet, or unreadable: start empty */ }
  }

  _save() {
    if (!this.cachePath) return;
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      const tmp = `${this.cachePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.cachePath);
    } catch (err) {
      logger.warn('Idle', `Could not save the idle data cache: ${err.message}`);
    }
  }

  // ---- fetching --------------------------------------------------------------------------

  async _get(pathAndQuery) {
    const res = await this._fetch(`${API}${pathAndQuery}`, { headers: { 'User-Agent': 'MVLP' } });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      const retryAfter = Number(res.headers?.get?.('retry-after'));
      err.retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 0;
      throw err;
    }
    return (await res.json()).MRData;
  }

  static _num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  static _startOf(race) {
    return Date.parse(`${race.date}T${race.time || '12:00:00Z'}`);
  }

  /** The weekend in order, as [{ label, start }] (UTC milliseconds), the race last. */
  static _sessionsOf(race) {
    const sessions = [];
    for (const [key, label] of SESSION_KEYS) {
      const s = race[key];
      if (s?.date) sessions.push({ label, start: Date.parse(`${s.date}T${s.time || '12:00:00Z'}`) });
    }
    sessions.push({ label: 'R', start: IdleData._startOf(race) });
    return sessions.filter((s) => Number.isFinite(s.start)).sort((a, b) => a.start - b.start);
  }

  async _fetchers() {
    const num = IdleData._num;
    return {
      calendar: async () => {
        const m = await this._get('/current.json?limit=100');
        return {
          fetchedAt: this._now(),
          version: CALENDAR_VERSION,
          races: m.RaceTable.Races.map((r) => ({
            round: num(r.round), name: r.raceName, date: r.date, time: r.time || null, start: IdleData._startOf(r), sessions: IdleData._sessionsOf(r),
            circuitId: r.Circuit.circuitId, locality: r.Circuit.Location.locality, country: r.Circuit.Location.country,
            lat: Number(r.Circuit.Location.lat), lon: Number(r.Circuit.Location.long),
          })),
        };
      },
      results: async () => {
        const m = await this._get('/current/last/results.json?limit=3');
        const race = m.RaceTable.Races[0];
        if (!race) return { fetchedAt: this._now(), race: null };
        return {
          fetchedAt: this._now(),
          race: {
            round: num(race.round), name: race.raceName, date: race.date, country: race.Circuit?.Location?.country || '',
            podium: race.Results.slice(0, 3).map((x) => ({
              position: num(x.position), code: x.Driver.code || x.Driver.familyName.slice(0, 3).toUpperCase(),
              number: String(x.Driver.permanentNumber || ''), constructorId: x.Constructor.constructorId,
            })),
          },
        };
      },
      drivers: async () => {
        const m = await this._get('/current/driverstandings.json?limit=3');
        const list = m.StandingsTable.StandingsLists[0];
        return {
          fetchedAt: this._now(),
          top: (list?.DriverStandings || []).slice(0, 3).map((x) => ({
            position: num(x.position), code: x.Driver.code || x.Driver.familyName.slice(0, 3).toUpperCase(),
            points: num(x.points), constructorId: x.Constructors?.[0]?.constructorId || '',
          })),
        };
      },
      constructors: async () => {
        const m = await this._get('/current/constructorstandings.json?limit=3');
        const list = m.StandingsTable.StandingsLists[0];
        return {
          fetchedAt: this._now(),
          top: (list?.ConstructorStandings || []).slice(0, 3).map((x) => ({
            position: num(x.position), constructorId: x.Constructor.constructorId, name: x.Constructor.name, points: num(x.points),
          })),
        };
      },
    };
  }

  static retryDelay(failures, retryAfterMs = 0) {
    const step = RETRY_STEPS_MS[Math.min(failures, RETRY_STEPS_MS.length) - 1];
    return Math.round(Math.max(step, Math.min(retryAfterMs, HOUR)) * (1 + Math.random() * RETRY_JITTER));
  }

  /**
   * Brings whatever is stale up to date, one request at a time. Anything that fails keeps its
   * old copy and is not tried again until its back-off has passed. Resolves to true if
   * something changed.
   */
  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      let changed = false;
      const fetchers = await this._fetchers();
      for (const key of Object.keys(TTL_MS)) {
        const held = this.data[key];
        const stale = !held || this._now() - held.fetchedAt > TTL_MS[key] || (key === 'calendar' && (held.version || 1) < CALENDAR_VERSION);
        const wait = this.failures[key]?.retryAt || 0;
        if (!stale || this._now() < wait) continue;
        try {
          this.data[key] = await fetchers[key]();
          delete this.failures[key];
          changed = true;
        } catch (err) {
          const count = (this.failures[key]?.count || 0) + 1;
          const delay = IdleData.retryDelay(count, err.retryAfterMs);
          this.failures[key] = { count, retryAt: this._now() + delay };
          logger.warn('Idle', `Could not update ${key}: ${err.message}. Trying again in ${Math.round(delay / 1000)} s.`);
        }
      }
      if (changed) this._save();
      return changed;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  // ---- what the screens show -----------------------------------------------------------------

  /** The next race, or the current one while it is on (`inProgress`). */
  nextRace() {
    const races = this.data.calendar?.races || [];
    const now = this._now();
    const race = races.filter((r) => Number.isFinite(r.start)).sort((a, b) => a.start - b.start).find((r) => r.start > now - RACE_LENGTH_MS);
    if (!race) return null;
    return { ...race, msUntil: race.start - now, inProgress: race.start <= now, code: countryCode(race.country) };
  }

  lastPodium() {
    const race = this.data.results?.race;
    if (!race || !race.podium?.length) return null;
    return {
      name: race.name, code: countryCode(race.country),
      podium: race.podium.map((p) => ({ ...p, tla: p.code, color: teamColor(p.constructorId) })),
    };
  }

  standings() {
    const drivers = this.data.drivers?.top || [];
    const constructors = this.data.constructors?.top || [];
    if (!drivers.length && !constructors.length) return null;
    return {
      drivers: drivers.map((d) => ({ ...d, color: teamColor(d.constructorId) })),
      constructors: constructors.map((c) => ({ ...c, code: teamCode(c.constructorId, c.name), color: teamColor(c.constructorId) })),
    };
  }

  /** The outline of a race's circuit ([[lon, lat], ...]) or null if the snapshot has no circuit there. */
  outlineFor(race) {
    if (!race || !Number.isFinite(race.lat)) return null;
    let best = null;
    for (const c of this.circuits) {
      const d = haversineKm(race.lat, race.lon, c.lat, c.lon);
      if (d <= MATCH_RADIUS_KM && (!best || d < best.d)) best = { c, d };
    }
    return best ? best.c.coords : null;
  }
}

module.exports = { IdleData, teamColor, teamCode, countryCode };
