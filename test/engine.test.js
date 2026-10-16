import assert from 'node:assert/strict';
import test from 'node:test';

import { creditsStart } from '../dist/engine/credits.js';
import { createEngine, credits, PLAYER, session, settle } from './helpers.js';

const types = (events) => events.map(([type]) => type);

function notify(engine, state, viewOffset, { ratingKey = '1', sessionKey = '7' } = {}) {
  engine.handleNotification({ clientIdentifier: PLAYER, sessionKey, ratingKey, state, viewOffset });
}

test('credits start exactly at the marker, re-armed by each position report', async () => {
  const { engine, clock, events } = createEngine({ markers: [credits(100_000)] });
  notify(engine, 'playing', 0);
  await settle();
  for (let t = 10_000; t <= 90_000; t += 10_000) {
    await clock.advance(10_000);
    notify(engine, 'playing', t);
  }
  await clock.advance(20_000);
  assert.deepEqual(events, [['play', 0, 0], ['credits.start', 100_000, 100_000]]);
});

test('a seek past the credits starts them at once; a seek far back cancels them', async () => {
  const { engine, clock, events } = createEngine({ markers: [credits(100_000)] });
  notify(engine, 'playing', 0);
  await settle();
  await clock.advance(5_000);
  notify(engine, 'buffering', 120_000);
  await clock.advance(5_000);
  notify(engine, 'playing', 20_000);
  assert.deepEqual(types(events), ['play', 'seek', 'credits.start', 'seek', 'credits.cancel']);
});

test('resume rewinding a few seconds into the run-up does not leave the credits', async () => {
  const { engine, clock, events } = createEngine({ markers: [credits(100_000)] });
  notify(engine, 'playing', 95_000);
  await settle();
  await clock.advance(10_000);
  notify(engine, 'paused', 105_000);
  await clock.advance(20_000);
  notify(engine, 'playing', 90_000); // client rewinds 15 s on resume
  await clock.advance(30_000);
  assert.deepEqual(types(events), ['play', 'credits.start', 'pause', 'seek', 'resume']);
});

test('pauses shorter than the debounce are ignored', async () => {
  const { engine, clock, events } = createEngine();
  notify(engine, 'playing', 0);
  await settle();
  await clock.advance(10_000);
  notify(engine, 'paused', 10_000);
  await clock.advance(1_000);
  notify(engine, 'playing', 10_000);
  await clock.advance(10_000);
  notify(engine, 'paused', 20_000);
  await clock.advance(5_000);
  notify(engine, 'playing', 20_000);
  assert.deepEqual(events, [['play', 0, 0], ['pause', 23_000, 20_000], ['resume', 26_000, 20_000]]);
});

test('the same change from the stream and a webhook counts once', async () => {
  const { engine, clock, events } = createEngine();
  engine.handleWebhook({ event: 'media.play', owner: true, session: session() });
  await settle();
  await clock.advance(10_000);
  notify(engine, 'playing', 10_000);
  notify(engine, 'paused', 12_000);
  await clock.advance(45);
  engine.handleWebhook({ event: 'media.pause', owner: true, session: session(), viewOffset: 12_000 });
  await clock.advance(5_000);
  notify(engine, 'playing', 12_000);
  await clock.advance(45);
  engine.handleWebhook({ event: 'media.resume', owner: true, session: session() });
  assert.deepEqual(types(events), ['play', 'pause', 'resume']);
});

test('stop waits for the hold, and autoplay of the next item cancels it', async () => {
  const { engine, clock, events } = createEngine();
  notify(engine, 'playing', 0);
  await settle();
  await clock.advance(60_000);
  notify(engine, 'stopped', 60_000);
  await clock.advance(3_000);
  notify(engine, 'playing', 0, { ratingKey: '2', sessionKey: '8' });
  await settle();
  // A late stop for the first item must not end the second.
  notify(engine, 'stopped', 60_000, { ratingKey: '1', sessionKey: '7' });
  await clock.advance(30_000);
  notify(engine, 'stopped', 30_000, { ratingKey: '2', sessionKey: '8' });
  await clock.advance(9_000);
  assert.deepEqual(types(events), ['play', 'play']);
  await clock.advance(2_000);
  assert.deepEqual(types(events), ['play', 'play', 'stop']);
  assert.equal(engine.snapshot(PLAYER).activity, 'idle');
});

test('buffering counts as playing', async () => {
  const { engine, clock, events } = createEngine();
  notify(engine, 'playing', 0);
  await settle();
  await clock.advance(10_000);
  notify(engine, 'buffering', 10_000);
  await clock.advance(5_000);
  notify(engine, 'playing', 10_000);
  assert.deepEqual(types(events), ['play']);
  assert.equal(engine.snapshot(PLAYER).activity, 'playing');
});

test('a webhook play without a position waits for a reported position before timing the credits', async () => {
  const { engine, clock, events } = createEngine({ markers: [credits(30_000)] });
  engine.handleWebhook({ event: 'media.play', owner: true, session: session() });
  await settle();
  await clock.advance(10_000);
  assert.deepEqual(types(events), ['play']);
  notify(engine, 'playing', 25_000);
  await clock.advance(5_000);
  assert.deepEqual(events.at(-1), ['credits.start', 15_000, 30_000]);
});

test('items shorter than the minimum length are ignored', async () => {
  const short = session({ media: { ratingKey: '1', title: 'Trailer', type: 'clip', durationMs: 120_000 } });
  const { engine, clock, events } = createEngine({ settings: { minItemLengthMs: 600_000 }, sessions: { 7: short } });
  notify(engine, 'playing', 0);
  await settle();
  await clock.advance(10_000);
  notify(engine, 'paused', 10_000);
  await clock.advance(10_000);
  notify(engine, 'stopped', 10_000);
  await clock.advance(20_000);
  assert.deepEqual(events, []);
});

test('the credits position follows the settings', () => {
  const mid = credits(6_000_000, { final: false });
  const final = credits(6_300_000, { final: true });
  assert.equal(creditsStart([final, mid], 7_000_000, { useFirstCreditsMarker: true, fallbackPercent: null }), 6_000_000);
  assert.equal(creditsStart([mid, final], 7_000_000, { useFirstCreditsMarker: false, fallbackPercent: null }), 6_300_000);
  assert.equal(creditsStart([], 7_000_000, { useFirstCreditsMarker: true, fallbackPercent: 95 }), 6_650_000);
  assert.equal(creditsStart([], 7_000_000, { useFirstCreditsMarker: true, fallbackPercent: null }), null);
  assert.equal(creditsStart([{ type: 'intro', startMs: 0, endMs: 60_000, final: false }], undefined, { useFirstCreditsMarker: true, fallbackPercent: 95 }), null);
});

test('dispose clears pending timers', async () => {
  const { engine, clock, events } = createEngine({ markers: [credits(100_000)] });
  notify(engine, 'playing', 0);
  await settle();
  engine.dispose();
  await clock.advance(200_000);
  assert.deepEqual(types(events), ['play']);
});
