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

test('state conditions', () => {
  const snapshot = (activity, inCredits = false) => ({ playerId: 'A', activity, inCredits, positionMs: 0 });
  assert.equal(stateHolds('playing', snapshot('playing')), true);
  assert.equal(stateHolds('playing', snapshot('playing', true)), false);
  assert.equal(stateHolds('playing-any', snapshot('playing', true)), true);
  assert.equal(stateHolds('paused', snapshot('paused')), true);
  assert.equal(stateHolds('credits', snapshot('paused', true)), true);
  assert.equal(stateHolds('credits', snapshot('idle', true)), false);
  assert.equal(stateHolds('active', snapshot('paused')), true);
  assert.equal(stateHolds('active', snapshot('idle')), false);
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
