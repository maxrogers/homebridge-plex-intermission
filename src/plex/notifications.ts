import { EventEmitter } from 'node:events';

import type { Logger, PlayingNotification } from '../engine/types.js';
import { describe } from '../errors.js';
import { parseNotification } from './convert.js';

export interface NotificationStreamOptions {
  url: string;
  log: Logger;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** How long a connection attempt may take before it is abandoned and retried. */
  connectTimeoutMs?: number;
}

interface StreamEvents {
  playing: [PlayingNotification];
  notification: [type: string];
  connected: [];
  disconnected: [];
}

/** How long the connection can be down before it is worth a warning, not just debug lines. */
const DOWN_WARNING_MS = 5 * 60_000;

/**
 * Plex Media Server push notifications over a websocket, reconnecting with backoff.
 * Needs no Plex Pass. The URL carries the token, so it is never logged.
 */
export class NotificationStream extends EventEmitter<StreamEvents> {
  private socket?: WebSocket;
  private retryTimer?: NodeJS.Timeout;
  private connectTimer?: NodeJS.Timeout;
  private backoffMs: number;
  private stopped = true;
  private connected = false;
  /** When the connection was lost (or first tried), while it is down; and whether that was warned about. */
  private downSince?: number;
  private warnedDown = false;

  constructor(private readonly options: NotificationStreamOptions) {
    super();
    this.backoffMs = options.minBackoffMs ?? 1_000;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.discard();
    this.setConnected(false);
  }

  private connect(): void {
    this.downSince ??= Date.now();
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url);
    } catch (error) {
      this.options.log.error('Cannot open Plex notifications: %s', describe(error));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    let lastError: string | undefined;
    // Some Node.js versions report a failed connection with an error event and never close the
    // socket, so a failure is handled once, from whichever comes first: error, close or the timeout.
    let ended = false;
    const end = (reason: string) => {
      if (ended || this.socket !== socket) {
        return;
      }
      ended = true;
      this.lost(reason);
    };

    this.connectTimer = setTimeout(() => end('timed out'), this.options.connectTimeoutMs ?? 15_000);
    socket.onopen = () => {
      clearTimeout(this.connectTimer);
      this.backoffMs = this.options.minBackoffMs ?? 1_000;
      if (this.warnedDown) {
        this.options.log.info('Plex notifications are back after %d minutes.', Math.round((Date.now() - (this.downSince ?? Date.now())) / 60_000));
      }
      this.downSince = undefined;
      this.warnedDown = false;
      this.setConnected(true);
    };
    socket.onmessage = (event) => {
      try {
        this.receive(event.data);
      } catch (error) {
        this.options.log.error('Error handling a Plex notification: %s', describe(error));
      }
    };
    socket.onerror = (event) => {
      const error = (event as { error?: unknown; message?: string }).error ?? (event as { message?: string }).message;
      lastError = error === undefined ? undefined : describe(error);
      // An open socket closes after an error; one that never opened may not, so it is ended here.
      if (socket.readyState !== WebSocket.OPEN) {
        end(lastError ?? 'connection failed');
      }
    };
    socket.onclose = (event) => {
      end([event.code ? `code ${event.code}` : '', event.reason, lastError].filter(Boolean).join(', ') || 'closed');
    };
  }

  /** Handles a lost or failed connection: logs it and schedules the next attempt. */
  private lost(reason: string): void {
    const wasConnected = this.connected;
    this.discard();
    this.downSince ??= Date.now();
    this.setConnected(false);
    if (this.stopped) {
      return;
    }
    this.options.log.debug('Plex notifications: %s (%s); trying again in %ss.', wasConnected ? 'connection closed' : 'cannot connect',
      reason, Math.round(this.backoffMs / 100) / 10);
    if (!this.warnedDown && Date.now() - this.downSince >= DOWN_WARNING_MS) {
      this.warnedDown = true;
      this.options.log.warn('Plex notifications still can\'t connect after %d minutes (%s). Pause, stop and credits timing wait for it; check that Homebridge can reach the Plex server.',
        DOWN_WARNING_MS / 60_000, reason);
    }
    this.scheduleReconnect();
  }

  /** Forgets the current socket, closing it without triggering its handlers. */
  private discard(): void {
    clearTimeout(this.connectTimer);
    this.connectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      try {
        socket.close();
      } catch {
        // Already closed or never opened.
      }
    }
  }

  private receive(data: unknown): void {
    const text = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8');
    const message = parseNotification(text);
    if (!message) {
      return;
    }
    this.emit('notification', message.type);
    for (const playing of message.playing) {
      this.emit('playing', playing);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs ?? 30_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) {
      return;
    }
    this.connected = connected;
    this.emit(connected ? 'connected' : 'disconnected');
  }
}
