// A stand-in for an Apple home hub: a real HAP controller (paired over HAP/IP, encrypted, subscribed to
// events like a hub), plus a model of Home automations driving virtual lights.
import hap from 'hap-controller';

const { HttpClient } = hap;
const short = (type) => String(type).replace(/^0*([0-9A-F]+)-0000-1000-8000-0026BB765291$/i, '$1').toUpperCase();
const OCCUPANCY = '71';
const SWITCH_EVENT = '73';
const NAME = '23';

export class Hub {
  constructor({ deviceId, port, pin }) {
    this.deviceId = deviceId;
    this.port = port;
    this.pin = pin;
    this.byName = new Map(); // name -> { iid key, kind }
    this.values = new Map(); // key -> last known value
    this.listeners = [];
    this.connected = false;
    this.events = [];
  }

  async pair() {
    const client = new HttpClient(this.deviceId, '127.0.0.1', this.port);
    await client.pairSetup(this.pin);
    this.pairing = client.getLongTermData();
    await client.close();
  }

  client() {
    return new HttpClient(this.deviceId, '127.0.0.1', this.port, this.pairing);
  }

  async connect() {
    this.http = this.client();
    const { accessories } = await this.http.getAccessories();
    for (const accessory of accessories) {
      let name;
      const found = [];
      for (const service of accessory.services) {
        for (const c of service.characteristics) {
          const type = short(c.type);
          if (type === NAME && short(service.type) === '3E') name = c.value;
          if (type === OCCUPANCY) found.push({ key: `${accessory.aid}.${c.iid}`, kind: 'sensor', value: c.value });
          if (type === SWITCH_EVENT) found.push({ key: `${accessory.aid}.${c.iid}`, kind: 'button' });
        }
      }
      for (const f of found) this.byName.set(name, f);
    }
    this.http.on('event', (event) => {
      for (const c of event.characteristics ?? []) {
        this.deliver(`${c.aid}.${c.iid}`, c.value, 'event');
      }
    });
    this.http.on('event-disconnect', () => { this.connected = false; });
    await this.http.subscribeCharacteristics([...this.byName.values()].map((f) => f.key));
    this.connected = true;
    // A hub that has just (re)connected reads the current values.
    for (const [, f] of this.byName) {
      if (f.kind !== 'sensor') continue;
      const read = await this.http.getCharacteristics([f.key]);
      const value = read.characteristics[0].value;
      this.deliver(f.key, value, 'read');
    }
  }

  async disconnect() {
    this.connected = false;
    try { await this.http.unsubscribeCharacteristics(); } catch { /* already gone */ }
    try { await this.http.close(); } catch { /* already gone */ }
    this.http.removeAllListeners();
  }

  nameOf(key) {
    for (const [name, f] of this.byName) if (f.key === key) return name;
    return key;
  }

  deliver(key, value, how) {
    const name = this.nameOf(key);
    const kind = this.byName.get(name)?.kind;
    const previous = this.values.get(key);
    this.values.set(key, value);
    this.events.push({ at: Date.now(), name, value, how });
    if (kind === 'button' && how === 'event') {
      for (const l of this.listeners) l({ type: 'press', name });
    } else if (kind === 'sensor' && previous !== undefined && previous !== value) {
      // Home automations run on a change; "read" covers a change first seen when reconnecting.
      for (const l of this.listeners) l({ type: 'change', name, value: Boolean(value), how });
    }
  }

  /**
   * "Get the state of <sensor>" in a shortcut: Home asks the accessory, so this reads it live over HAP.
   * When the hub is offline it falls back to the last value it saw.
   */
  async isOn(name) {
    const f = this.byName.get(name);
    if (!f) return false;
    if (this.connected) {
      try {
        const read = await this.http.getCharacteristics([f.key]);
        return Boolean(read.characteristics[0].value);
      } catch { /* fall through */ }
    }
    return Boolean(this.values.get(f.key));
  }
}

/** A dimmable light with a command log. */
export class Light {
  constructor(name) {
    this.name = name;
    this.level = 100;
    this.commands = [];
  }

  set(level, why) {
    level = Math.max(0, Math.min(100, Math.round(level)));
    if (level !== this.level) this.commands.push({ at: Date.now(), from: this.level, to: level, why });
    this.level = level;
  }
}

/**
 * Home automations for one light. `rules` maps a trigger to an action:
 *   { on: 'press', name } | { on: 'detect', name } and action { set: level } | { ramp: { to, steps, everyMs, cancelIf } }.
 * Shortcuts run independently, as in Home: a new automation does not stop a ramp already running.
 */
export class Rig {
  constructor(name, hub, rules, { reactToReconnect = true } = {}) {
    this.name = name;
    this.reactToReconnect = reactToReconnect;
    this.hub = hub;
    this.light = new Light(name);
    this.rules = rules;
    this.ramps = 0;
    hub.listeners.push((trigger) => this.handle(trigger));
  }

  handle(trigger) {
    if (trigger.how === 'read' && !this.reactToReconnect) {
      return;
    }
    for (const rule of this.rules) {
      const matches = rule.on === 'press'
        ? trigger.type === 'press' && trigger.name === rule.name
        : trigger.type === 'change' && trigger.name === rule.name && trigger.value === true;
      if (matches) this.run(rule, trigger.name);
    }
  }

  run(rule, why) {
    if (rule.set !== undefined) {
      this.light.set(rule.set, why);
      return;
    }
    const { to, steps, everyMs, cancelIf } = rule.ramp;
    this.ramps++;
    let step = 0;
    const tick = async () => {
      if (cancelIf && await this.hub.isOn(cancelIf)) return; // "If Media Playing is detected, stop this shortcut"
      const remaining = steps - step;
      this.light.set(this.light.level + (to - this.light.level) / remaining, `${why} (fade)`);
      step++;
      if (step < steps) setTimeout(() => void tick(), everyMs);
    };
    void tick();
  }
}
