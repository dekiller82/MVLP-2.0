'use strict';

const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { shell } = require('electron');
const logger = require('./logger');
const store = require('./store');

const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPE = 'user-read-currently-playing';
const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const NOW_PLAYING_URL = 'https://api.spotify.com/v1/me/player/currently-playing';

class SpotifyManager extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.clientId = '';
    this.clientSecret = '';
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenExpiresAt = 0;
    this.lastTrackId = undefined;
    this.suspended = false;
    this.pollTimer = null;
    this.callbackServer = null;
  }

  async start(clientId, clientSecret) {
    if (this.running) this.stop();
    this.clientId = clientId;
    this.clientSecret = clientSecret;

    if (!clientId || !clientSecret) {
      this.emit('status', { state: 'error', message: 'Missing credentials.' });
      return;
    }

    this.running = true;

    const stored = store.getSpotifyTokens();
    try {
      if (stored?.refreshToken) {
        this.refreshToken = stored.refreshToken;
        await this._refreshAccessToken();
      } else {
        await this._authorize();
      }
      this.emit('status', { state: 'connected' });
      logger.info('Spotify', 'Connected to Spotify API.');
      this._pollLoop();
    } catch (err) {
      logger.error('Spotify', `Connection failed: ${err.message}`);
      this.emit('status', { state: 'error', message: err.message });
      this.running = false;
    }
  }

  /** Pauses art updates (e.g. while Multiviewer is live); resuming re-emits the current track. */
  setSuspended(suspended) {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    logger.info('Spotify', suspended ? 'Suspended while Multiviewer is live.' : 'Resumed.');
    if (!suspended) this.lastTrackId = undefined;
  }

  stop() {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.callbackServer) {
      try { this.callbackServer.close(); } catch { /* noop */ }
      this.callbackServer = null;
    }
  }

  _authorize() {
    return new Promise((resolve, reject) => {
      const state = crypto.randomBytes(16).toString('hex');
      const authUrl = new URL(AUTHORIZE_URL);
      authUrl.searchParams.set('client_id', this.clientId);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
      authUrl.searchParams.set('scope', SCOPE);
      authUrl.searchParams.set('state', state);

      const server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url, REDIRECT_URI);
          if (url.pathname !== '/callback') {
            res.writeHead(404).end();
            return;
          }
          const code = url.searchParams.get('code');
          const returnedState = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body style="font-family:sans-serif;background:#111318;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>MVLP connected to Spotify. You can close this tab.</p></body></html>');

          server.close();
          this.callbackServer = null;

          if (error) return reject(new Error(error));
          if (returnedState !== state) return reject(new Error('State mismatch.'));
          if (!code) return reject(new Error('No authorization code received.'));

          await this._exchangeCode(code);
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      this.callbackServer = server;
      server.listen(8888, '127.0.0.1', () => {
        shell.openExternal(authUrl.toString());
      });
      server.on('error', (err) => reject(err));
    });
  }

  async _exchangeCode(code) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    });
    const tokens = await this._tokenRequest(body);
    this._applyTokens(tokens);
  }

  async _refreshAccessToken() {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
    });
    const tokens = await this._tokenRequest(body);
    this._applyTokens(tokens);
  }

  async _tokenRequest(body) {
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Token request failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  _applyTokens(tokens) {
    this.accessToken = tokens.access_token;
    this.tokenExpiresAt = Date.now() + (tokens.expires_in || 3600) * 1000 - 30000;
    if (tokens.refresh_token) this.refreshToken = tokens.refresh_token;
    store.setSpotifyTokens({ refreshToken: this.refreshToken });
  }

  async _ensureToken() {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt) {
      await this._refreshAccessToken();
    }
  }

  async _pollLoop() {
    if (!this.running) return;
    try {
      await this._pollOnce();
    } catch (err) {
      logger.error('Spotify', `Polling error: ${err.message}`);
      this.lastTrackId = undefined;
    }
    if (this.running) this.pollTimer = setTimeout(() => this._pollLoop(), 3000);
  }

  async _pollOnce() {
    if (this.suspended) return;
    await this._ensureToken();
    const res = await fetch(NOW_PLAYING_URL, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });

    if (res.status === 204) {
      this.lastTrackId = null;
      return;
    }
    if (!res.ok) throw new Error(`Now-playing request failed (${res.status})`);

    const data = await res.json();
    const item = data?.item;
    if (!item) {
      this.lastTrackId = null;
      return;
    }

    if (item.id === this.lastTrackId) return;
    this.lastTrackId = item.id;
    logger.info('Spotify', `New track: ${item.name}`);

    const images = item.album?.images || [];
    if (!images.length) return;

    const artRes = await fetch(images[0].url);
    if (!artRes.ok) throw new Error('Failed to download album art.');
    const arrayBuffer = await artRes.arrayBuffer();
    this.emit('art', Buffer.from(arrayBuffer));
  }
}

module.exports = { SpotifyManager, REDIRECT_URI };
