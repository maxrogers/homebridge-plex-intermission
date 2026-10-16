// Replays playback recorded from a real Plex server and Apple TV (see the fixture descriptions).
import assert from 'node:assert/strict';
import test from 'node:test';

import { createEngine, loadFixture, settle } from './helpers.js';

async function replay(name) {
  const fixture = await loadFixture(name);
  const info = {
    playerId: fixture.player.id,
    playerTitle: fixture.player.title,
    product: fixture.player.product,
    platform: fixture.player.platform,
    user: fixture.user,
    media: {
      ratingKey: fixture.media.ratingKey,
      title: fixture.media.title,
      type: fixture.media.type,
      durationMs: fixture.media.durationMs,
      librarySectionId: fixture.library.id,
      librarySectionTitle: fixture.library.title,
    },
  };
  const { engine, clock, events, start } = createEngine({
    markers: fixture.media.markers,
    sessions: { 7: info },
  });
  for (const input of fixture.events) {
    await clock.advanceTo(start + input.at);
    if (input.source === 'stream') {
      engine.handleNotification({
        clientIdentifier: info.playerId,
        sessionKey: input.sessionKey,
        ratingKey: info.media.ratingKey,
        state: input.state,
        viewOffset: input.viewOffset,
      });
    } else {
      engine.handleWebhook({ event: input.event, owner: true, session: info, viewOffset: input.viewOffset });
    }
    await settle();
  }
  await clock.advance(60_000);
  return { fixture, events: events.filter(([type]) => type !== 'seek') };
}

test('stream only: pauses, resumes and stop, no credits', async () => {
  const { events } = await replay('stream-seeks.json');
  assert.deepEqual(events.map(([type]) => type), ['play', 'pause', 'resume', 'pause', 'resume', 'pause', 'resume', 'stop']);
});

test('stream and webhooks: credits start when the marker is reached', async () => {
  const { fixture, events } = await replay('credits.json');
  assert.deepEqual(events.map(([type]) => type), ['play', 'pause', 'resume', 'pause', 'resume', 'credits.start', 'pause', 'stop']);

  // Expected moment: the last position report before the marker, plus the time left to the marker.
  const marker = fixture.media.markers[0].startMs;
  const last = fixture.events.filter((e) => e.source === 'stream' && e.state === 'playing' && e.viewOffset < marker).at(-1);
  const expectedAt = last.at + (marker - last.viewOffset);
  const [, at, position] = events.find(([type]) => type === 'credits.start');
  assert.ok(Math.abs(at - expectedAt) < 50, `credits started at ${at} ms, expected ${expectedAt} ms`);
  assert.ok(Math.abs(position - marker) < 50, `credits started at position ${position}, marker ${marker}`);
});
