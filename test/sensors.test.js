import assert from 'node:assert/strict';
import test from 'node:test';

import * as hap from '@homebridge/hap-nodejs';

import { matchesFilters, stateHolds } from '../dist/sensors/rules.js';
import { SensorAccessory } from '../dist/sensors/sensor-accessory.js';

const none = { players: [], users: [], libraries: [], mediaTypes: [] };
const media = { ratingKey: '1', title: 'Movie', type: 'movie', librarySectionId: '1' };

test('empty filters allow everything; set filters need a matching value', () => {
  assert.equal(matchesFilters(none, {}), true);
  assert.equal(matchesFilters({ ...none, players: ['A'] }, { playerId: 'A', media }), true);
  assert.equal(matchesFilters({ ...none, players: ['A'] }, { playerId: 'B', media }), false);
  assert.equal(matchesFilters({ ...none, players: ['A'] }, { media }), false, 'no player fails a player filter');
  assert.equal(matchesFilters({ ...none, libraries: ['1'], mediaTypes: ['movie'] }, { media }), true);
  assert.equal(matchesFilters({ ...none, mediaTypes: ['episode'] }, { media }), false);
  assert.equal(matchesFilters({ ...none, libraries: ['srv-a/1'] }, { serverId: 'srv-a', media }), true, 'server-qualified library');
  assert.equal(matchesFilters({ ...none, libraries: ['srv-b/1'] }, { serverId: 'srv-a', media }), false, 'same section on another server');
});

test('state conditions, with and without the credits and intro', () => {
  const snapshot = (activity, inCredits = false, inIntro = false) => ({ playerId: 'A', activity, inCredits, inIntro, positionMs: 0 });
  assert.equal(stateHolds('playing', snapshot('playing', true)), true, 'Playing includes the credits by default');
  assert.equal(stateHolds('playing', snapshot('playing', true), ['credits']), false, 'except during the credits');
  assert.equal(stateHolds('playing', snapshot('playing', false, true), ['credits']), true, 'the intro still counts');
  assert.equal(stateHolds('playing', snapshot('playing', false, true), ['credits', 'intro']), false);
  assert.equal(stateHolds('paused', snapshot('paused')), true);
  assert.equal(stateHolds('paused', snapshot('paused', true), ['credits']), false, 'a pause in the credits stays credits');
  assert.equal(stateHolds('credits', snapshot('paused', true)), true);
  assert.equal(stateHolds('credits', snapshot('idle', true)), false);
  assert.equal(stateHolds('intro', snapshot('playing', false, true)), true);
  assert.equal(stateHolds('active', snapshot('paused')), true);
  assert.equal(stateHolds('active', snapshot('idle')), false);
  assert.equal(stateHolds('idle', snapshot('idle')), true);
});

test('media conditions match the item\'s details', async () => {
  const { mediaMatches } = await import('../dist/sensors/rules.js');
  const facts = { aspectRatio: 2.39, resolution: '4k', dynamicRange: 'dv', contentRating: 'PG', labels: ['Date Night'] };
  assert.equal(mediaMatches({}, undefined), true, 'no conditions');
  assert.equal(mediaMatches({ shape: 'wide' }, undefined), false, 'details not read yet');
  assert.equal(mediaMatches({ shape: 'wide' }, facts), true);
  assert.equal(mediaMatches({ shape: 'standard' }, facts), false);
  assert.equal(mediaMatches({ shape: 'wide' }, { ...facts, aspectRatio: 1.85 }), false);
  assert.equal(mediaMatches({ resolution: ['hd', '4k'] }, facts), true);
  assert.equal(mediaMatches({ dynamicRange: ['hdr'] }, facts), true, 'Dolby Vision counts as HDR');
  assert.equal(mediaMatches({ dynamicRange: ['sdr'] }, facts), false);
  assert.equal(mediaMatches({ ratings: ['g', 'pg'] }, facts), true, 'ratings ignore case');
  assert.equal(mediaMatches({ labels: ['date night'] }, facts), true);
  assert.equal(mediaMatches({ labels: ['Kids'] }, facts), false);
  assert.equal(mediaMatches({ shape: 'wide', ratings: ['R'] }, facts), false, 'every group must match');
  const { parseConfig } = await import('../dist/config.js');
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const [sensor, button] = parseConfig({ sensors: [
    { id: 'a', name: 'a', type: 'occupancy', state: 'playing', media: { shape: 'round', resolution: ['4k', '8k'], ratings: [], labels: ['Kids', 'Kids'] } },
    { id: 'b', name: 'b', type: 'button', events: ['play'], media: { shape: 'wide' } },
  ] }, log).sensors;
  assert.deepEqual(sensor.media, { resolution: ['4k'], labels: ['Kids'] });
  assert.deepEqual(button.media, {}, 'buttons have no media conditions');
});

test('older configs keep their meaning', async () => {
  const { parseConfig } = await import('../dist/config.js');
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const sensors = parseConfig({ sensors: [
    { id: 'a', name: 'a', type: 'occupancy', state: 'playing-any' },
    { id: 'b', name: 'b', type: 'occupancy', state: 'playing' },
    { id: 'c', name: 'c', type: 'occupancy', state: 'paused' },
    { id: 'd', name: 'd', type: 'occupancy', state: 'playing', except: [] },
    { id: 'e', name: 'e', type: 'occupancy', state: 'credits', except: ['credits'] },
  ] }, log).sensors;
  assert.deepEqual(sensors.map((s) => `${s.state}:${s.except.join('+')}`), ['playing:', 'playing:credits', 'paused:credits', 'playing:', 'credits:']);
});

function accessory(config, existing) {
  const target = existing ?? new hap.Accessory(config.name, hap.uuid.generate(config.id));
  target.context ??= {}; // PlatformAccessory has a persisted context; a bare HAP accessory does not.
  return new SensorAccessory({ hap }, target, { filters: none, events: [], ...config });
}

test('occupancy, motion and contact sensors report their state', () => {
  const occupancy = accessory({ id: 'a', name: 'Playing', type: 'occupancy' });
  const service = occupancy.accessory.getService(hap.Service.OccupancySensor);
  assert.equal(service.getCharacteristic(hap.Characteristic.OccupancyDetected).value, 0);
  occupancy.setActive(true);
  assert.equal(service.getCharacteristic(hap.Characteristic.OccupancyDetected).value, 1);

  const contact = accessory({ id: 'b', name: 'Credits', type: 'contact' });
  const state = () => contact.accessory.getService(hap.Service.ContactSensor).getCharacteristic(hap.Characteristic.ContactSensorState).value;
  assert.equal(state(), hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
  contact.setActive(true);
  assert.equal(state(), hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED, 'on is open');

  const motion = accessory({ id: 'c', name: 'Motion', type: 'motion' });
  motion.setActive(true);
  assert.equal(motion.accessory.getService(hap.Service.MotionSensor).getCharacteristic(hap.Characteristic.MotionDetected).value, true);
});

test('buttons only offer a single press', () => {
  const button = accessory({ id: 'd', name: 'Paused', type: 'button' });
  const event = button.accessory.getService(hap.Service.StatelessProgrammableSwitch).getCharacteristic(hap.Characteristic.ProgrammableSwitchEvent);
  assert.deepEqual(event.props.validValues, [hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS]);
  button.press();
});

test('changing a sensor type swaps the service on the same accessory', () => {
  const first = accessory({ id: 'e', name: 'Thing', type: 'occupancy' });
  const second = accessory({ id: 'e', name: 'Thing', type: 'button' }, first.accessory);
  assert.equal(second.accessory.getService(hap.Service.OccupancySensor), undefined);
  assert.ok(second.accessory.getService(hap.Service.StatelessProgrammableSwitch));
  assert.ok(second.accessory.getService(hap.Service.AccessoryInformation));
});

test('a sensor starts in the state it had before Homebridge restarted', () => {
  const first = accessory({ id: 'f', name: 'Playing', type: 'occupancy' });
  first.setActive(true);
  const again = accessory({ id: 'f', name: 'Playing', type: 'occupancy' }, first.accessory);
  assert.equal(again.accessory.getService(hap.Service.OccupancySensor).getCharacteristic(hap.Characteristic.OccupancyDetected).value, 1);
});
