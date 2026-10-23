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
  assert.deepEqual(events, [['play', 0, 0], ['pause', 22_500, 20_000], ['resume', 26_000, 20_000]]);
});

test('Apple TV skip bursts (pause, jump, play up to about 1.3 s apart) never count as a pause', async () => {
  const { engine, clock, events } = createEngine();
  notify(engine, 'playing', 6_720_000);
  await settle();
  // Recorded from an Apple TV skipping back 10 s at a time: gaps of 1.08, 0.2 and 1.23 s.
  let position = 6_720_000;
  for (const gap of [1_080, 200, 1_230]) {
    await clock.advance(700);
    notify(engine, 'paused', position);
    await clock.advance(gap);
    position -= 10_000;
    notify(engine, 'playing', position);
  }
  await clock.advance(10_000);
  assert.deepEqual(types(events).filter((t) => t !== 'seek'), ['play']);
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

test('a stop near the end waits for the hold, and autoplay of the next item cancels it', async () => {
  const { engine, clock, events } = createEngine();
  notify(engine, 'playing', 7_150_000); // 50 s before the end of a 2-hour movie
  await settle();
  await clock.advance(30_000);
  notify(engine, 'stopped', 7_180_000);
  await clock.advance(3_000);
  notify(engine, 'playing', 0, { ratingKey: '2', sessionKey: '8' });
  await settle();
  // A late stop for the first item must not end the second.
  notify(engine, 'stopped', 7_180_000, { ratingKey: '1', sessionKey: '7' });
  await clock.advance(30_000);
  assert.deepEqual(types(events), ['play', 'play']);
  assert.equal(engine.snapshot(PLAYER).activity, 'playing');
});

test('a stop near the end with no autoplay ends after the full hold', async () => {
  const { engine, clock, events } = createEngine();
  notify(engine, 'playing', 6_600_000); // in the final tenth
  await settle();
  await clock.advance(5_000);
  notify(engine, 'stopped', 6_605_000);
  await clock.advance(9_000);
  assert.deepEqual(types(events), ['play']);
  await clock.advance(1_000);
  assert.deepEqual(events.at(-1), ['stop', 15_000, 6_605_000]);
});

test('a stop in the credits waits for the full hold', async () => {
  const { engine, clock, events } = createEngine({ markers: [credits(3_000_000)] });
  notify(engine, 'playing', 2_990_000);
  await settle();
  await clock.advance(20_000);
  notify(engine, 'stopped', 3_010_000);
  await clock.advance(9_000);
  assert.deepEqual(types(events), ['play', 'credits.start']);
  await clock.advance(1_000);
  assert.deepEqual(types(events), ['play', 'credits.start', 'stop']);
});

test('a stop partway through counts after 1 second', async () => {
  const { engine, clock, events } = createEngine();
  notify(engine, 'playing', 56_000);
  await settle();
  await clock.advance(20_000);
  notify(engine, 'stopped', 76_000);
  await clock.advance(999);
  assert.deepEqual(types(events), ['play']);
  await clock.advance(1);
  assert.deepEqual(events.at(-1), ['stop', 21_000, 76_000]);
  assert.equal(engine.snapshot(PLAYER).activity, 'idle');
});

test('a paused item stopped partway through counts after 1 second', async () => {
  const { engine, clock, events } = createEngine();
  notify(engine, 'playing', 56_000);
  await settle();
  await clock.advance(10_000);
  notify(engine, 'paused', 66_000);
  await clock.advance(60_000);
  notify(engine, 'stopped', 66_000);
  await clock.advance(1_000);
  assert.deepEqual(types(events), ['play', 'pause', 'stop']);
});

test('without a known runtime a stop waits the full hold, except for Live TV', async () => {
  for (const [media, expected] of [[{ ratingKey: '1', title: 'Trailer', type: 'clip' }, 10_000], [{ ratingKey: '1', title: 'News', type: 'episode', live: true }, 1_000]]) {
    const { engine, clock, events } = createEngine({ sessions: { 7: session({ media }) } });
    notify(engine, 'playing', 20_000);
    await settle();
    notify(engine, 'stopped', 20_000);
    await clock.advance(expected - 1);
    assert.deepEqual(types(events), ['play'], media.title);
    await clock.advance(1);
    assert.deepEqual(types(events), ['play', 'stop'], media.title);
  }
});

test('stopped and playing again within milliseconds (seen while seeking on iPhone) is not a stop', async () => {
  const { engine, clock, events } = createEngine();
  notify(engine, 'playing', 16_000);
  await settle();
  await clock.advance(10_000);
  notify(engine, 'stopped', 26_000);
  await clock.advance(2);
  notify(engine, 'playing', 26_000);
  await clock.advance(5_000);
  assert.deepEqual(types(events), ['play']);
});

test('a stop hold shorter than 1 second applies everywhere, and 0 ends at once', async () => {
  for (const [stopHoldMs, expected] of [[500, 500], [0, 0]]) {
    const { engine, clock, events } = createEngine({ settings: { stopHoldMs } });
    notify(engine, 'playing', 56_000);
    await settle();
    notify(engine, 'stopped', 56_000);
    await clock.advance(expected);
    assert.deepEqual(events.at(-1), ['stop', expected, 56_000], `stop hold ${stopHoldMs}`);
  }
});

test('a session Plex does not list yet waits for the webhook instead of using a placeholder', async () => {
  const lookups = [];
  const { engine, clock, events } = createEngine({ resolveSession: async (...args) => { lookups.push(args); return undefined; } });
  const seen = [];
  engine.on('event', (event) => seen.push(event.session.playerTitle));
  notify(engine, 'buffering', 187_000);
  await settle();
  await clock.advance(75);
  engine.handleWebhook({ event: 'media.play', owner: true, session: session(), viewOffset: 187_000 });
  await clock.advance(5_000);
  assert.deepEqual(types(events), ['play']);
  assert.deepEqual(seen, ['Apple TV']);
  assert.equal(lookups.length, 1, 'no retry once the webhook named the session');
});

test('the session lookup is retried before a placeholder is used', async () => {
  let calls = 0;
  const { engine, clock, events } = createEngine({ resolveSession: async () => (++calls < 3 ? undefined : session()) });
  notify(engine, 'playing', 0);
  await settle();
  assert.deepEqual(events, []);
  await clock.advance(2_000);
  assert.equal(calls, 3);
  assert.deepEqual(events, [['play', 2_000, 2_000]]);
  assert.equal(engine.snapshot(PLAYER).session.playerTitle, 'Apple TV');
});

test('a placeholder session is replaced by the next webhook for the same item', async () => {
  const { engine, clock, events } = createEngine({ resolveSession: async () => undefined, markers: [credits(100_000)] });
  const seen = [];
  engine.on('event', (event) => seen.push([event.type, event.session.media.title]));
  notify(engine, 'playing', 0);
  await settle();
  await clock.advance(2_000);
  assert.deepEqual(seen, [['play', '']], 'placeholder after the retries');
  assert.equal(engine.snapshot(PLAYER).session.playerTitle, undefined);
  engine.handleWebhook({ event: 'media.resume', owner: true, session: session(), viewOffset: 2_000 });
  await settle();
  assert.deepEqual(seen, [['play', ''], ['play', 'Movie']]);
  assert.equal(engine.snapshot(PLAYER).session.playerTitle, 'Apple TV');
  await clock.advance(98_000);
  assert.deepEqual(types(events), ['play', 'play', 'credits.start'], 'markers for the real item apply');
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
  assert.equal(creditsStart([final, mid], 7_000_000, { creditsMode: 'first', fallbackPercent: null }), 6_000_000);
  assert.equal(creditsStart([mid, final], 7_000_000, { creditsMode: 'final', fallbackPercent: null }), 6_300_000);
  assert.equal(creditsStart([], 7_000_000, { creditsMode: 'first', fallbackPercent: 95 }), 6_650_000);
  assert.equal(creditsStart([], 7_000_000, { creditsMode: 'first', fallbackPercent: null }), null);
  assert.equal(creditsStart([], 7_000_000, { creditsMode: 'first', fallbackPercent: 95 }, 'episode'), 6_650_000);
  for (const type of ['track', 'photo', 'clip']) {
    assert.equal(creditsStart([], 7_000_000, { creditsMode: 'first', fallbackPercent: 95 }, type), null, `no fallback for ${type}`);
  }
  assert.equal(creditsStart([{ type: 'intro', startMs: 0, endMs: 60_000, final: false }], undefined, { creditsMode: 'first', fallbackPercent: 95 }), null);
});

test('dispose clears pending timers', async () => {
  const { engine, clock, events } = createEngine({ markers: [credits(100_000)] });
  notify(engine, 'playing', 0);
  await settle();
  engine.dispose();
  await clock.advance(200_000);
  assert.deepEqual(types(events), ['play']);
});

const sceneMarkers = [
  { type: 'credits', startMs: 100_000, endMs: 160_000, final: false }, // first credits
  // 60 s mid-credits scene from 160 s to 220 s
  { type: 'credits', startMs: 220_000, endMs: 400_000, final: true },
];

test('mid-credits scenes: credits stop for the scene and start again after it', async () => {
  const { engine, clock, events } = createEngine({ markers: sceneMarkers });
  notify(engine, 'playing', 95_000);
  await settle();
  await clock.advance(200_000);
  assert.deepEqual(events.map(([type, at]) => [type, at]), [
    ['play', 0], ['credits.start', 5_000], ['credits.cancel', 65_000], ['credits.start', 125_000],
  ]);
});

test('mid-credits scenes can be ignored: first or final credits only', async () => {
  for (const [creditsMode, expected] of [['first', [['play', 0], ['credits.start', 5_000]]], ['final', [['play', 0], ['credits.start', 125_000]]]]) {
    const { engine, clock, events } = createEngine({ markers: sceneMarkers, settings: { creditsMode } });
    notify(engine, 'playing', 95_000);
    await settle();
    await clock.advance(200_000);
    assert.deepEqual(events.map(([type, at]) => [type, at]), expected, creditsMode);
  }
});

test('a resume rewind inside the scene does not flick back to credits', async () => {
  const { engine, clock, events } = createEngine({ markers: sceneMarkers });
  notify(engine, 'playing', 165_000); // in the scene
  await settle();
  await clock.advance(5_000);
  notify(engine, 'paused', 170_000);
  await clock.advance(10_000);
  notify(engine, 'playing', 155_000); // rewinds 15 s, back into the first credits
  await clock.advance(1_000);
  assert.deepEqual(types(events), ['play', 'pause', 'seek', 'resume']);
});

test('a resume rewind from the final credits into the scene keeps the credits', async () => {
  const { engine, clock, events } = createEngine({ markers: sceneMarkers });
  notify(engine, 'playing', 225_000);
  await settle();
  await clock.advance(5_000);
  notify(engine, 'paused', 230_000);
  await clock.advance(10_000);
  notify(engine, 'playing', 215_000);
  await clock.advance(20_000);
  assert.deepEqual(types(events), ['play', 'credits.start', 'pause', 'seek', 'resume']);
});

test('items without credits (music, photos, Other Videos) never get a credits event', async () => {
  const media = (type, librarySectionId = '1') => ({ 7: session({ media: { ratingKey: '1', title: 'Item', type, durationMs: 200_000, librarySectionId } }) });
  const run = async (options) => {
    const { engine, clock, events } = createEngine({ settings: { fallbackPercent: 95 }, ...options });
    notify(engine, 'playing', 180_000);
    await settle();
    await clock.advance(30_000);
    return types(events);
  };
  assert.deepEqual(await run({ sessions: media('movie') }), ['play', 'credits.start'], 'a movie uses the fallback');
  assert.deepEqual(await run({ sessions: media('track') }), ['play'], 'a track does not');
  const notOtherVideos = (m) => m.librarySectionId !== '9';
  assert.deepEqual(await run({ sessions: media('movie', '9'), hasCredits: notOtherVideos }), ['play'], 'an Other Videos item does not');
  assert.deepEqual(await run({ sessions: media('movie', '9'), hasCredits: notOtherVideos, markers: [credits(190_000)] }), ['play'], 'not even with a marker');
});

test('intro: starts and ends with the marker; skipping it ends it at once', async () => {
  const intro = { type: 'intro', startMs: 30_000, endMs: 90_000, final: false };
  const { engine, clock, events } = createEngine({ markers: [intro, credits(1_000_000)] });
  notify(engine, 'playing', 20_000);
  await settle();
  await clock.advance(15_000); // 35 s
  notify(engine, 'playing', 35_000);
  await clock.advance(5_000);
  notify(engine, 'playing', 95_000); // Skip Intro
  await clock.advance(1_000);
  assert.deepEqual(types(events), ['play', 'intro.start', 'seek', 'intro.end']);
  assert.equal(engine.snapshot(PLAYER).inIntro, false);
});
