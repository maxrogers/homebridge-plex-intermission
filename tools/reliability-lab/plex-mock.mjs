// A fake Plex Media Server that behaves like the real one where Intermission is concerned:
// - websocket "playing" notifications every 10 s while playing, and at once on pause, resume, seek and stop,
//   but the first one after pressing play arrives late (measured: up to 10 s);
// - optional webhooks (multipart) that arrive immediately;
// - /status/sessions, /library/metadata/<id>?includeMarkers=1, /identity, /:/prefs.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

export class MockPlex {
  constructor({ port, playStartLagMs = 3000, webhookUrl, serverId = 'mock-server' }) {
    this.port = port;
    this.playStartLagMs = playStartLagMs;
    this.webhookUrl = webhookUrl;
    this.serverId = serverId;
    this.session = undefined; // { player, item, state, offsetMs, at, sessionKey }
    this.items = new Map();
    this.sessionKey = 1;
    this.sockets = new Set();
    this.log = [];
    this.sessionsDelayMs = 0;
  }

  addItem(item) {
    this.items.set(item.ratingKey, item);
  }

  async start() {
    this.http = createServer((req, res) => this.handle(req, res));
    this.ws = new WebSocketServer({ noServer: true });
    this.http.on('upgrade', (req, socket, head) => {
      this.ws.handleUpgrade(req, socket, head, (client) => {
        this.sockets.add(client);
        client.on('close', () => this.sockets.delete(client));
      });
    });
    await new Promise((resolve) => this.http.listen(this.port, '127.0.0.1', resolve));
    this.ticker = setInterval(() => {
      if (this.session?.state === 'playing') {
        this.notify();
      }
    }, 10_000);
  }

  async close() {
    clearInterval(this.ticker);
    for (const s of this.sockets) s.terminate();
    this.ws.close();
    await new Promise((resolve) => this.http.close(resolve));
  }

  /** Drops every websocket connection, as when the server restarts or the network blips. */
  dropSockets() {
    for (const s of this.sockets) s.terminate();
  }

  position() {
    const s = this.session;
    if (!s) return 0;
    return s.state === 'playing' ? s.offsetMs + (Date.now() - s.at) : s.offsetMs;
  }

  metadata(item) {
    return {
      ratingKey: item.ratingKey, key: `/library/metadata/${item.ratingKey}`, title: item.title, type: item.type,
      duration: item.durationMs, librarySectionID: 1, librarySectionTitle: 'Movies',
    };
  }

  handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const json = (body) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (url.pathname === '/identity') return json({ MediaContainer: { machineIdentifier: this.serverId, version: '1.41.0' } });
    if (url.pathname === '/:/prefs') return json({ MediaContainer: { Setting: [{ id: 'WebHooksEnabled', value: true }] } });
    if (url.pathname === '/status/sessions' && this.sessionsDelayMs > 0 && !req.delayed) {
      req.delayed = true;
      setTimeout(() => this.handle(req, res), this.sessionsDelayMs);
      return;
    }
    if (url.pathname === '/status/sessions') {
      const s = this.session;
      const items = s && s.state !== 'stopped' ? [{
        ...this.metadata(s.item), sessionKey: String(s.sessionKey), viewOffset: Math.round(this.position()),
        Player: { machineIdentifier: s.player, title: 'Living Room', product: 'Plex for Apple TV', state: s.state, local: true },
        User: { title: 'Steve' },
      }] : [];
      return json({ MediaContainer: { size: items.length, Metadata: items } });
    }
    const meta = /^\/library\/metadata\/(\w+)$/.exec(url.pathname);
    if (meta) {
      const item = this.items.get(meta[1]);
      return json({ MediaContainer: { Metadata: item ? [{ ...this.metadata(item), Marker: item.markers ?? [] }] : [] } });
    }
    res.writeHead(404).end();
  }

  notify() {
    const s = this.session;
    if (!s) return;
    const message = JSON.stringify({ NotificationContainer: { type: 'playing', size: 1, PlaySessionStateNotification: [{
      sessionKey: String(s.sessionKey), clientIdentifier: s.player, ratingKey: s.item.ratingKey,
      viewOffset: Math.round(this.position()), state: s.state, key: `/library/metadata/${s.item.ratingKey}`,
    }] } });
    for (const socket of this.sockets) socket.send(message);
  }

  async webhook(event) {
    if (!this.webhookUrl || !this.session) return;
    const s = this.session;
    const payload = JSON.stringify({
      event, user: true, owner: true, Account: { title: 'Steve' }, Server: { uuid: this.serverId, title: 'Mock' },
      Player: { uuid: s.player, title: 'Living Room', local: true, publicAddress: '' },
      Metadata: { ...this.metadata(s.item), viewOffset: Math.round(this.position()) },
    });
    const boundary = 'mockboundary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--\r\n`;
    try {
      await fetch(this.webhookUrl, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body });
    } catch {
      // The plugin may be restarting.
    }
  }

  record(what) {
    this.log.push({ at: Date.now(), what, state: this.session?.state ?? 'idle', positionMs: Math.round(this.position()) });
  }

  // ---- player actions ----
  play(ratingKey, offsetMs = 0, player = 'APPLE-TV') {
    this.session = { player, item: this.items.get(ratingKey), state: 'playing', offsetMs, at: Date.now(), sessionKey: this.sessionKey++ };
    this.record('play');
    void this.webhook('media.play');
    const key = this.session.sessionKey;
    setTimeout(() => { if (this.session?.sessionKey === key) this.notify(); }, this.playStartLagMs);
  }

  pause() {
    const s = this.session;
    s.offsetMs = this.position(); s.at = Date.now(); s.state = 'paused';
    this.record('pause');
    this.notify(); void this.webhook('media.pause');
  }

  resume() {
    const s = this.session;
    s.at = Date.now(); s.state = 'playing';
    this.record('resume');
    this.notify(); void this.webhook('media.resume');
  }

  seek(offsetMs) {
    const s = this.session;
    s.offsetMs = offsetMs; s.at = Date.now();
    this.record('seek');
    this.notify();
  }

  stop() {
    const s = this.session;
    s.offsetMs = this.position(); s.at = Date.now(); s.state = 'stopped';
    this.record('stop');
    this.notify(); void this.webhook('media.stop');
    this.session = undefined;
  }
}
