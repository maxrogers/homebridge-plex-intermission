import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

import { discover } from '../dist/plex/discovery.js';
import { connectionCandidates, PlexTv } from '../dist/plex/plex-tv.js';
import { PlexHttpError, PlexServer } from '../dist/plex/server.js';
import { Storage } from '../dist/storage.js';

const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

const message = (error) => (error instanceof Error ? error.message : String(error));

class IntermissionUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.storage = new Storage(this.homebridgeStoragePath);
    /** The PIN being signed in with. Kept here so the browser never sees more than the code. */
    this.pending = undefined;

    this.handle('/status', () => this.status());
    this.handle('/signin/start', (body) => this.startSignIn(body));
    this.handle('/signin/check', () => this.checkSignIn());
    this.handle('/signout', () => this.signOut());
    this.handle('/servers', () => this.servers());
    this.handle('/server/select', (body) => this.selectServer(body));
    this.handle('/discover', (body) => this.discover(body));
    this.handle('/webhook', async () => ({ path: `/${(await this.storage.state()).webhookSecret}` }));
    this.ready();
  }

  /** Wraps a handler so failures reach the page as a readable message, never with a token. */
  handle(path, handler) {
    this.onRequest(path, async (body) => {
      try {
        return await handler(body ?? {});
      } catch (error) {
        if (error instanceof RequestError) {
          throw error;
        }
        if (error instanceof PlexHttpError && error.status === 401) {
          throw new RequestError('Plex did not accept the sign-in. Please sign in again.', { status: 401 });
        }
        throw new RequestError(message(error), { status: 500 });
      }
    });
  }

  async plexTv() {
    const { clientIdentifier } = await this.storage.state();
    return new PlexTv({ clientIdentifier });
  }

  async credentials() {
    const credentials = await this.storage.readCredentials();
    if (!credentials) {
      throw new RequestError('Not signed in to Plex.', { status: 401 });
    }
    return credentials;
  }

  async status() {
    const credentials = await this.storage.readCredentials();
    if (!credentials) {
      return { signedIn: false };
    }
    try {
      const user = await (await this.plexTv()).user(credentials.accountToken);
      return { signedIn: true, username: user.title || user.username, plexPass: user.plexPass };
    } catch (error) {
      if (error instanceof PlexHttpError && error.status === 401) {
        return { signedIn: false, expired: true };
      }
      // plex.tv unreachable: still signed in as far as we know.
      return { signedIn: true, username: credentials.username, plexPass: undefined, warning: message(error) };
    }
  }

  async startSignIn({ mode }) {
    const plexTv = await this.plexTv();
    const strong = mode !== 'code';
    const pin = await plexTv.createPin(strong);
    this.pending = { pin, startedAt: Date.now() };
    return strong ? { authUrl: plexTv.authUrl(pin) } : { code: pin.code, linkUrl: 'https://plex.tv/link' };
  }

  async checkSignIn() {
    const pending = this.pending;
    if (!pending) {
      throw new RequestError('Sign-in was not started.', { status: 400 });
    }
    if (Date.now() - pending.startedAt > SIGN_IN_TIMEOUT_MS) {
      this.pending = undefined;
      return { done: false, expired: true };
    }
    const plexTv = await this.plexTv();
    const token = await plexTv.checkPin(pending.pin);
    if (!token) {
      return { done: false };
    }
    this.pending = undefined;
    const user = await plexTv.user(token);
    await this.storage.writeCredentials({ accountToken: token, username: user.title || user.username, savedAt: new Date().toISOString() });
    return { done: true, username: user.title || user.username, plexPass: user.plexPass };
  }

  async signOut() {
    this.pending = undefined;
    await this.storage.deleteCredentials();
    return { signedIn: false };
  }

  async servers() {
    const credentials = await this.credentials();
    const servers = await (await this.plexTv()).servers(credentials.accountToken);
    return servers.map((server) => ({ id: server.id, name: server.name, owned: server.owned }));
  }

  async selectServer({ id }) {
    const credentials = await this.credentials();
    const { clientIdentifier } = await this.storage.state();
    const server = (await (await this.plexTv()).servers(credentials.accountToken)).find((s) => s.id === id);
    if (!server) {
      throw new RequestError('That server is no longer on your Plex account.', { status: 404 });
    }
    const token = server.accessToken ?? credentials.accountToken;
    const url = await PlexServer.findWorkingUrl(connectionCandidates(server), { token, clientIdentifier, machineIdentifier: server.id });
    if (!url) {
      throw new RequestError(`Cannot reach ${server.name} from Homebridge. Check that both are on the same network.`, { status: 502 });
    }
    // Confirms the token works on this server, not just that it answers.
    await new PlexServer({ baseUrl: url, token, clientIdentifier }).libraries();
    await this.storage.writeCredentials({ ...credentials, serverToken: server.accessToken });
    return { id: server.id, name: server.name, url };
  }

  async discover({ url }) {
    if (typeof url !== 'string' || !url) {
      throw new RequestError('Choose a server first.', { status: 400 });
    }
    const credentials = await this.credentials();
    const { clientIdentifier } = await this.storage.state();
    const server = new PlexServer({ baseUrl: url, token: credentials.serverToken ?? credentials.accountToken, clientIdentifier });
    return discover(server, await this.plexTv(), credentials.accountToken);
  }
}

new IntermissionUiServer();
