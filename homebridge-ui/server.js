import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';

class IntermissionUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/status', () => ({ signedIn: false }));
    this.ready();
  }
}

new IntermissionUiServer();
