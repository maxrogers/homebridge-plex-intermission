import { timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { Logger } from '../engine/types.js';
import { describe } from '../errors.js';
import { extractWebhookPayload } from './multipart.js';

export interface WebhookServerOptions {
  port: number;
  /** Address to listen on. Defaults to all interfaces. */
  host?: string;
  /** Random path segment; requests to any other path are rejected. */
  secret: string;
  log: Logger;
  maxBodyBytes?: number;
}

/** Receives Plex webhooks on `http://<host>:<port>/<secret>`. */
export class WebhookServer extends EventEmitter<{ payload: [unknown] }> {
  private server?: Server;
  /** When a request to another address was last logged; such requests are logged at most once a minute. */
  private rejectedLoggedAt = 0;

  constructor(private readonly options: WebhookServerOptions) {
    super();
  }

  get path(): string {
    return `/${this.options.secret}`;
  }

  /** Compares in constant time, so response timing reveals nothing about the key. */
  private isOurs(path: string): boolean {
    const expected = Buffer.from(this.path);
    const actual = Buffer.from(path);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** The port actually listened on (useful when configured as 0), or undefined when stopped. */
  get port(): number | undefined {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : undefined;
  }

  /** Resolves once listening. Rejects if the port cannot be used (for example EADDRINUSE). */
  start(): Promise<void> {
    if (this.server) {
      return Promise.resolve();
    }
    const server = createServer((request, response) => this.handle(request, response));
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    this.server = server;
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.server = undefined;
        reject(error);
      };
      server.once('error', onError);
      server.listen(this.options.port, this.options.host, () => {
        server.off('error', onError);
        server.on('error', (error) => this.options.log.error('Webhook server error: %s', error.message));
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const ours = this.isOurs((request.url ?? '').split('?')[0] ?? '');
    if (request.method === 'GET' && ours) {
      // Lets the settings page confirm that this port belongs to Intermission.
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"app":"intermission"}');
      return;
    }
    if (request.method !== 'POST' || !ours) {
      response.writeHead(404).end();
      request.resume();
      if (Date.now() - this.rejectedLoggedAt > 60_000) {
        this.rejectedLoggedAt = Date.now();
        // An old Intermission address still registered in Plex shows up here; the key itself is never logged.
        this.options.log.debug('Webhook port: ignored a %s from %s to an address that isn\'t this Homebridge\'s webhook.', request.method, request.socket.remoteAddress ?? 'unknown');
      }
      return;
    }
    const limit = this.options.maxBodyBytes ?? 1_000_000;
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        response.writeHead(413).end();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (size > limit) {
        return;
      }
      response.writeHead(200).end();
      const payload = extractWebhookPayload(Buffer.concat(chunks), request.headers['content-type']);
      if (payload === undefined) {
        this.options.log.debug('Ignored a webhook without a readable payload');
        return;
      }
      try {
        this.emit('payload', payload);
      } catch (error) {
        this.options.log.error('Error handling a Plex webhook: %s', describe(error));
      }
    });
    request.on('error', (error) => this.options.log.debug('Webhook request failed: %s', error.message));
  }
}
