# Intermission for Plex: design

How the plugin works and why: what Plex reports, how playback becomes sensor states, and the measurements behind
the timing choices.

## Goals

- Turn Plex playback into HomeKit sensors that Apple Home automations can use: lights down when a movie plays, up
  gently when the credits start (never before), a little when paused.
- Event-driven. Plex pushes changes; the plugin reads from Plex only around those events. No polling.
- Set up in a few taps: sign in with Plex, pick devices, choose a preset.
- Apple Home only. The plugin never controls lights; Home automations do.

Not goals: controlling lights directly; Homebridge 1.

Requires Homebridge 2, Node.js 22.10 or later (24, 26), and a Plex Media Server. Plex Pass on the server owner's account
adds webhooks and credits detection for new media, but is not required.

## What Plex reports

Measured with Plex Media Server 1.43 and Plex for Apple TV, using `tools/intermission-probe.mjs` (October 2026), then
checked against a real evening's diagnostics log.

| Source | Kind | Plex Pass | What it gives |
|---|---|---|---|
| Server notifications (`/:/websockets/notifications`) | Push, websocket | Not needed | State, position, item, player ID and session for every client report: every 10 s while playing, and at once on pause, resume, buffering, seek, skip and stop. No player name or user. |
| Webhooks | Push, HTTP POST | Needed | 12 event types with full metadata. Arrived 0.1 to 0.9 s before the session list showed the change. |
| Sessions (`/status/sessions`) | Pull | Not needed | Player, user, item and state of current playback |
| Markers (`/library/metadata/{id}?includeMarkers=1`) | Pull, once per item | Detection needs Plex Pass | Credits and intro markers, with a `final` flag on the last credits |

What shaped the design:

- **Seeks and skips send no webhook** but appear on the notification stream at once, as `buffering` at the new
  position followed by `playing`. The stream, not polling, keeps the credits timer accurate.
- **Which arrives first:** for pause, resume and stop the stream led the webhook by about 45 ms. For play the webhook
  wins; the stream's first report comes with the player's next 10-second report. Both are used, whichever is first.
- **Buffering** has no webhook; it counts as playing. **Stop** appears on the stream, so it works without webhooks.
- **Resume rewinds** a few seconds (a per-device setting the server can't read). The plugin uses the reported position.
- **Apple TV skips** report paused, then playing at the new position. Of about 50 skips, most gaps were under 0.4 s and
  the longest 1.23 s; deliberate pauses lasted 2.3 s or more. Hence the 1.5 s pause debounce.
- **Autoplay** (next episode, trailers, a cinema trailer into the movie) stops the item at or near its end and starts the
  next 0.6 to 7 s later. New playback after a stop partway through was always the user choosing something else. An
  iPhone seeking reported stopped then playing again 2 to 7 ms apart.
- **A new session can be missing from `/status/sessions`** for a moment after its first notification. The webhook for
  the same play arrived 3 to 76 ms later with the full session.
- **`media.scrobble`** arrived at 90.1% with Plex's default completion behaviour.
- Position extrapolation is accurate: 10.005 s of position per 10.002 s of wall time between Apple TV reports.

## Components

```
Plex server ──notifications──▶ NotificationStream ─┐
Plex (Plex Pass) ──webhooks──▶ WebhookServer ──────┼─▶ Controller (one per server) ─▶ PlaybackEngine (per player)
                                                   │          │                            │ events
                                                   │          ▼                            ▼
                                                   │   sensor states, button presses ◀─────┘
                                                   ▼
                                          SensorHub (one per sensor, shared by servers) ─▶ HomeKit accessory
```

| Module | Role |
|---|---|
| `src/engine/` | Per-player state machine; credits, intro, pause and stop timing |
| `src/plex/` | Server and plex.tv clients, notification websocket, webhook receiver, payload parsing, marker cache |
| `src/controller.ts` | One per server: feeds the engine, re-evaluates state sensors on every event, presses buttons |
| `src/sensors/` | Filters and conditions (`rules.ts`), HomeKit services (`sensor-accessory.ts`), combining servers (`sensor-hub.ts`) |
| `src/platform.ts` | Homebridge platform: accessories, start-up, daily Plex Pass check, shutdown |
| `src/setup-service.ts`, `src/report.ts` | What the settings page asks of Plex; the diagnostics file |
| `homebridge-ui/` | Settings page (`public/`) and its request handler (`server.js`) |

## Playback engine

One state machine per player: idle, playing, paused (buffering counts as playing), with credits and intro tracked
alongside. Events: `play`, `pause`, `resume`, `stop`, `seek`, `credits.start`, `credits.cancel`, `intro.start`,
`intro.end`. Every input is applied idempotently, so the same change from the stream and a webhook counts once.

### Credits

1. Each position report (notification, webhook `viewOffset`, or session read) is stored with its time. While playing,
   the current position is the last report plus the time since.
2. A timer is set for the next credits boundary and re-set on every report, so a seek moves it at once.
3. Credits come from the item's credits markers, cached per item; an item without markers is checked again after
   6 hours. A movie or episode without markers uses 95% of its runtime (adjustable, or off). Music, photos, Other
   Videos and Live TV never get credits.
4. **Latch:** once in the credits, a rewind of less than the re-arm distance (60 s) never leaves them, so the rewind on
   resume can't flick the lights.
5. **What counts as the credits** is one setting for every sensor: by default every credits marker starts credits, so a
   mid-credits scene between two markers counts as playing; or the first marker starts credits to the end; or only the
   final credits count. It is shared because sensors that follow the credits must agree: with a choice per sensor,
   "Playing, except the credits" and "In the credits" could both be off during a scene.

Intros come from intro markers, read in the same request. Skip Intro is a seek past the marker and ends the intro.

### Pauses

A pause counts after 1.5 s (adjustable in half-second steps). Shorter pauses, including skip bursts, change nothing.

### Stops

Only a stop at the end can be followed by autoplay, so the wait depends on where playback stopped:

- **Near the end** (in or past the first credits, the final 10% of the runtime, or the last 60 s): the stop hold,
  10 s by default, so the next episode never passes through Nothing Playing. An unknown position or runtime counts as
  near the end, except for Live TV.
- **Anywhere else:** 1 s (or the stop hold, if shorter): long enough for players that stop and resume within
  milliseconds, short enough that leaving a movie brings the lights up promptly.

### Session lookup

A notification has no player name or item details, so the first one for a new item reads `/status/sessions`. If the
session isn't listed yet, the read is retried twice, 1 s apart; a webhook for the same play usually arrives first and
supplies the session. Only then is a placeholder used (player ID, no title), and the next webhook for that item
replaces it and sends `play` again so sensors re-check their filters.

### Reads from Plex

| Moment | Reads |
|---|---|
| New item | One session read (skipped when a webhook supplied it), one marker read (cached) |
| Item with media conditions | One metadata read (cached) |
| Homebridge start, stream reconnect | One session read to restore state |
| Stream down while something plays | A session read every 5 minutes (Safety re-sync) until it reconnects |
| Daily | Plex Pass status and the library list |

## Sensors

Each sensor is one HomeKit accessory. State sensors are occupancy (recommended), motion or contact sensors; buttons are
stateless programmable switches.

| Condition | Optional exceptions | Used by |
|---|---|---|
| Playing | credits, intro | Simple (none); Simple + Credits and Every State (credits) |
| Paused | credits, intro | Every State (credits, so a pause during the credits stays in the credits) |
| Playing or paused | credits, intro | |
| In the credits | | Every State |
| In the intro | | |
| Nothing playing | | Every State |

Filters (players, people, libraries; libraries as `serverId/sectionId`, including Live TV) are OR within a filter and
AND across them; an empty filter allows everything. State sensors can also have **media conditions** on the library
item: picture shape (wide is 2.2:1 or wider), resolution, HDR (HDR includes Dolby Vision), content rating and Plex
labels (an episode also uses its show's). They are read from `/library/metadata`, not the session, so transcoding
can't change them, and unknown values fail. A letterboxed 2.39:1 film encoded as 16:9 reports 1.78; a Plex label is
the reliable choice for those.

Buttons press on engine events or webhook-only events (`media.scrobble`, `media.rate`, `library.new`,
`library.on.deck`, `playback.started`, `device.new`, `admin.database.backup`, `admin.database.corrupted`). Without
Plex Pass, buttons that only use webhook events are marked "Needs Plex Pass" and don't press.

- **Several servers:** each server has its own controller; a state sensor is on while any server says so, and Nothing
  Playing only while all agree.
- **Ordering:** at each event, state sensors that turn off are updated before those that turn on, then buttons press,
  so Every State never shows two sensors on and a shortcut started by a press sees the new states.
- **Restarts:** sensors start from their saved state and keep it until Plex has been read (or 20 s pass), so a hub
  reconnecting early never sees Nothing Playing mid-movie.
- **Names** are cleaned to what the Home app accepts: letters, numbers, spaces and common punctuation, starting and
  ending with a letter or number.

### Presets

| Preset | Sensors |
|---|---|
| Simple | Media Playing (playing) |
| Simple + Credits | Media Playing (playing, except the credits) |
| Every State | Media Playing and Media Paused (both except the credits), Credits Rolling, Nothing Playing |

A preset is only these settings, so anything it makes can be edited or built from scratch. Every State's sensors are
grouped (`group: "states:<id>"`) because they depend on each other; the Sensors tab shows them under one header with
"Remove set", and a note when an edit means more than one, or none, could be on. A preset added to existing sensors
goes alongside them, or replaces them; a replacing sensor with the same name keeps that sensor's ID, so its Home
automations survive.

### Sensors or buttons: lab results

`tools/reliability-lab` runs the plugin in a real Homebridge against a simulated Plex server, with a HAP controller as
the hub and modelled Home automations driving virtual lights. Scripted run, 20 checks:

| Rig | Right | Failed |
|---|---|---|
| Buttons only | 14/20 | hub offline at a pause; rewind out of the credits; playback resumed during a Homebridge restart; a credits fade running into the next episode |
| Sensors only | 20/20 | none |
| Sensors, hub ignoring changes it sees on reconnect | 15/20 | the outage and restart cases, until the next change |
| One sensor and three buttons | 18/20 | pause and credits missed while the hub was offline |

A sensor's state can always be read again; a missed press is gone. So every preset uses sensors. Quick pause and skip
bursts produced no light changes on any rig: the debounce and credits latch absorb them before HomeKit sees anything.

## Fades in Apple Home

HomeKit has no transition time, so fades are Home automations converted to shortcuts: Set the lights, Wait 1 second,
Set again. An If step reads a sensor (for example "Credits Rolling Occupancy Detected is No") and stops the shortcut if
playback came back mid-fade. The Guide tab gives the steps and recipes. The plugin can't create Home automations.

## Plex Pass

| | With Plex Pass | Without |
|---|---|---|
| Pause, resume, stop, seeks | Instant | Instant |
| Play | Instant (webhook) | At the player's next report, up to 10 s |
| Credits | Markers, then the fallback | Markers already on the server, then the fallback |
| Webhook-only events | Available | Not available |

Plex Pass is read from `plex.tv/api/v2/user` at sign-in, at start, daily and whenever the settings page opens. The
last status is kept; a change is logged once and shown on the settings page until dismissed. Without Plex Pass the
webhook receiver doesn't start; when Plex Pass returns it starts without a restart, and the settings page offers to add
the webhook (it changes the user's Plex account, so it is never done silently). Sensors are never changed when Plex
Pass comes or goes, so Home automations keep working.

## Settings page

Plain ES modules (`app.js`, `guide.js`, and `model.js` for testable helpers), following Homebridge's light or dark mode.

**Setup:** sign in (Plex's sign-in page in a pop-up, or a code for plex.tv/link), choose servers, review Plex Pass and
webhooks, choose players, people and libraries (Movies and TV preselected), then a preset. Nothing is saved until the
last step. The last step also offers Intermission's own child bridge, on by default and only at first setup, since
moving sensors between bridges later re-creates them in Apple Home.

**Tabs:** Sensors (cards with a plain-language summary, drag to reorder, an editor per sensor with a Now playing
panel), Guide (automations for the presets in use first, with Home app screenshots), Settings (setup, credits,
webhooks, advanced, diagnostics, reset).

**Sign-in:** a PIN from `plex.tv/api/v2/pins`, polled until it carries a token. Players combine the account's devices,
each server's device list and play history, and current sessions, most used first.

**Webhooks:** the account's webhook list comes from `plex.tv/api/v2/user/webhooks` (used by Plex Web, not publicly
documented). The page shows it, keeps every entry, and removes only what the user marks. The whole list is always
written back, and re-read afterwards; if a kept webhook went missing, the list is written again. Adding the webhook
also turns on the server's Webhooks setting when it's off. The address is this machine's IPv4 address on the server's
subnet (or a manual override) and ends in a random 128-bit key. The receiver rejects any other path (compared in
constant time), caps the body size, ignores payloads from other servers, and answers a GET on its path with
`{"app":"intermission"}` so the page can tell whether the port is free, Intermission's, or another app's.

**Child bridge:** `_bridge` is written as Homebridge's own "Use Child Bridge" does. After the restart the Sensors tab
shows the pairing QR code and code until the bridge is paired, read from HAP-NodeJS's own record of the bridge; the
setup URI is computed as `Accessory.setupURI()` does (checked in the tests).

**Restart banner:** at start the plugin records a fingerprint of the config it loaded. The page compares it with the
saved config and says whether changes are unsaved, saved but waiting for a restart, or running.

## Settings reference

| Setting | Default | Range |
|---|---|---|
| What counts as the credits | Mid-credits scenes count as playing | Or as credits; or final credits only |
| No credits marker | 95% of the runtime | Off, or 50 to 99% |
| Credits offset | 0 s | 0 to 120 s after the marker |
| Credits re-arm distance | 60 s | 20 to 600 s |
| Pause debounce | 1.5 s | 0 to 30 s, half-second steps |
| Stop hold (near the end) | 10 s | 0 to 60 s; other stops count after 1 s |
| Minimum item length | 0 (off) | 0 to 60 min |
| Safety re-sync | 5 min | 0 (off) to 30 min, only while the stream is down |
| Webhooks | On, port 32550, address detected | Port 1024 to 65535, or a manual address |
| Detailed logging | Off | |

## Storage and security

In `<Homebridge storage>/intermission/`, folder 0700 and files 0600, written atomically:

| File | Contents |
|---|---|
| `credentials.json` | Plex account token, per-server tokens for shared servers, username, `setupId` |
| `state.json` | This install's Plex client ID and webhook key |
| `plex-pass.json` | Last Plex Pass status and whether its change was shown |
| `running.json` | Fingerprint of the running config |
| `diagnostics.log`, `diagnostics.1.log` | The kept log, about 1 MB each |

Tokens never appear in `config.json`, logs, diagnostics or the settings page; the page only learns "signed in as".
Encrypting the token with a key on the same disk would add no real protection, so file permissions are the control.
Homebridge keeps a plugin's storage folder when the plugin is removed, so credentials carry a `setupId` that is also
in the plugin's config; a config without it means the sign-in is left over, and it is deleted. No analytics; the only
hosts contacted are plex.tv and the user's Plex servers.

## Logging and diagnostics

The normal log has start-up, connections, every sensor turning on or off with what was playing, commands, Plex Pass
changes, and errors with what to do. Detailed logging adds every Plex report and engine event, credits and intro ranges
and why, which sensors follow a playback and why not, debounced pauses, stop holds and session retries.

Everything, detailed lines included, is also kept in `diagnostics.log` whatever the setting, with titles, people,
players and command lines wrapped in invisible markers. **Diagnostics** in Settings builds one text file from the
setup, every sensor and the last 6,000 kept lines; tokens, the webhook key and public addresses are removed, and marked
values become "Title 1", "Player 1" and so on unless names are included.

## Lifecycle and errors

- Nothing connects to Plex until the platform is configured and signed in; sensors still exist so automations keep
  working.
- On `shutdown` the webhook server, websockets and timers are closed.
- Errors from Plex, the network, webhooks, websocket messages and timers are caught and logged; timer callbacks run
  through a guard, and a webhook port in use is a clear log error, not a crash.
- No environment variables; settings come from the config and the sign-in from storage.

`test/runtime.test.js` starts the plugin with no configuration, with only the platform configured and with a full
configuration before sign-in, and checks that it shuts down cleanly.

## Open questions

- Does a POST to `plex.tv/api/v2/user/webhooks` replace the whole list? The plugin always writes the full list.
- Does "Stop this shortcut" end a run early when a home hub runs the automation? It is offered in the Home app's
  shortcut editor.
- Does the server's `/accounts` name always match the user name in sessions and webhooks? People filters compare names.

## Attribution

The credits-aware approach comes from [homebridge-plex-credits](https://github.com/DavidD303/homebridge-plex-metadata/tree/credits-aware-playback)
by DavidD303, a fork of [homebridge-plex-metadata](https://github.com/davidmuzi/homebridge-plex-metadata) by
davidmuzi. Both are MIT licensed.
