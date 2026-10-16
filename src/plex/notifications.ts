import { EventEmitter } from 'node:events';

import type { Logger, PlayingNotification } from '../engine/types.js';
import { parseNotification } from './convert.js';

export interface NotificationStreamOptions {
  url: string;
  log: Logger;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

interface StreamEvents {
  playing: [PlayingNotification];
  notification: [type: string];
  connected: [];
  disconnected: [];
}

/**
 * Plex Media Server push notifications over a websocket, reconnecting with backoff.
 * Needs no Plex Pass. The URL carries the token, so it is never logged.
 */
export class NotificationStream extends EventEmitter<StreamEvents> {
  private socket?: WebSocket;
  private retryTimer?: NodeJS.Timeout;
  private backoffMs: number;
  private stopped = true;
  private connected = false;

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
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close();
    }
    this.setConnected(false);
  }

  private connect(): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url);
    } catch (error) {
      this.options.log.error('Cannot open Plex notifications: %s', error instanceof Error ? error.message : String(error));
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.backoffMs = this.options.minBackoffMs ?? 1_000;
      this.setConnected(true);
    };
    socket.onmessage = (event) => this.receive(event.data);
    socket.onerror = () => {
      // The close event that follows handles reconnecting.
    };
    socket.onclose = () => {
      this.socket = undefined;
      this.setConnected(false);
      this.scheduleReconnect();
    };
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
    if (this.stopped) {
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
