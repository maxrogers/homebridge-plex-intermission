# Intermission for Plex: design

How the plugin is designed to work. Pre-release (0.1.0, not yet on npm): built as described here unless Build status
says otherwise.

## Goals

- Turn Plex playback into HomeKit sensors that Apple Home automations can use.
- Typical use: lights fade down when a movie plays, fade up gently when the credits start (not before),
  and come up more quickly on pause or stop.
- Event-driven. Plex pushes changes to the plugin; the plugin reads from Plex only at moments chosen
  around those events. No continuous polling.
- A first-run experience that feels effortless: sign in, pick your devices, accept a suggested setup, done.
- Apple Home only. The plugin never controls lights directly; Home automations do.

Non-goals: direct control of Lutron, Kasa or any other lights; Homebridge v1.

## Requirements

- Homebridge 2.x only. v1 is not supported or tested (`engines.homebridge: ^2.0.0`).
- Node.js 22.10 or later, 24 or 26.
- Plex Media Server, signed in with the server owner's account for full functionality.
- Plex Pass on the server owner's account for webhooks and credits detection (see [Plex Pass](#plex-pass)).

## Signals available from Plex

Measured on 2026-10-16 with Plex Media Server 1.43.4 and Plex for Apple TV (`tools/intermission-probe.mjs`).

| Source | Direction | Plex Pass | What it gives | Measured behaviour |
|---|---|---|---|---|
| Webhooks | Push (HTTP POST, multipart JSON) | Required | 12 event types with full metadata | Arrived 0.1 to 0.9 s before the session API showed the change. `viewOffset` present in about 1 in 5 payloads. |
| Server notifications (`/:/websockets/notifications`) | Push (websocket) | Not required | `playing` notifications: state, position, `ratingKey`, `clientIdentifier` (player), `sessionKey`, play queue IDs. No user or player name. Also library, activity and background-queue events | One per client timeline report: every 10 s while playing, and immediately on pause, resume, buffering, seek, skip and stop. Arrived about 0.1 s before the session API showed the same change |
| Sessions (`/status/sessions`) | Pull | Not required | State, position, player, user, media | Apple TV refreshes position every 10.0 s while playing, and immediately on pause or resume |
| Markers (`/library/metadata/{id}?includeMarkers=1`) | Pull, once per item | Detection needs Plex Pass | Credits and intro markers with `final` flag | 25 of 25 sampled movies and episodes had credits markers |

Findings that shape the design:

- **Seeks and skips while playing send no webhook, but they do appear on the server notification stream at once.**
  Every tap-forward (10 s), repeated tap (30, 60 s), held fast-forward and scrub produced a `buffering` notification with
  the new position, followed by `playing`. So the notification stream, not polling, keeps the credits timer accurate.
- **Buffering** appears with no webhook. It is treated as playing.
- **Stop** appears on the notification stream as `state: stopped`, so stop is detected even without webhooks.
- **Which arrives first:** for pause, resume and stop, the notification stream led the webhook by about 45 ms every time.
  For **playback start** the webhook wins: `media.play` arrived at once, while the stream's first report came with the
  player's next 10-second timeline report. Both sources are used, and whichever arrives first is acted on; the other is
  de-duplicated.
- **Resume rewinds** by a client-side amount (15 s on the test Apple TV, a per-device app setting that the server cannot read).
  The plugin never needs that setting because it reads the real position after resume.
- **`media.scrobble`** fires at the earlier of the played threshold and the first credits marker under Plex's default
  completion behaviour (`LibraryVideoPlayedAtBehaviour = 3`). In testing it arrived at 90.1%. It is used as a free
  re-sync trigger near the end.
- **Rapid pause and resume** pairs arrived as little as 67 ms apart, so pause and stop are debounced.
- **Apple TV skips** (10 s forward or back) report paused, then playing at the new position. In a real evening's log
  (Oct 2026, about 50 skips) the gap was under 0.4 s for most and at most 1.23 s; deliberate pauses lasted 2.3 s or
  more. This sets the pause debounce (1.5 s).
- **Autoplay** (next episode, the next trailer, cinema trailers into the movie) stops the item at or near its end and
  starts the next 0.6 to 7 s later. In that log, new playback after a stop partway through an item was always the user
  starting something. An iPhone seeking reported stopped and then playing again 2 to 7 ms apart.
- **A new session can be missing from `/status/sessions`** for a moment after its first notification (twice in that
  log, both right after a stop). The webhook for the same play arrived 3 ms and 76 ms after the notification, with the full session.
- Position extrapolation is accurate: between Apple TV reports, position advanced 10.005 s per 10.002 s of wall time.

## Events

### Plex webhook events (all published types)

| Event | Description | Sent for |
|---|---|---|
| `media.play` | Playback started | User |
| `media.pause` | Playback paused | User |
| `media.resume` | Playback resumed | User |
| `media.stop` | Playback stopped | User |
| `media.scrobble` | Item passed the played threshold | User |
| `media.rate` | Item rated | User |
| `library.new` | Item added to a library the user can access | User |
| `library.on.deck` | Item appeared in On Deck | User |
| `playback.started` | A shared user started playback on the server | Owner only |
| `device.new` | A device accessed the server | Owner only |
| `admin.database.backup` | Scheduled database backup finished | Owner only |
| `admin.database.corrupted` | Database corruption detected | Owner only |

Any event type not in this table is logged at debug level and shown in the Live tab, so unpublished types are discovered rather than dropped.

### Derived events (created by the plugin)

| Event | When |
|---|---|
| `credits.start` | Position reaches the credits marker (first or final, per setting) plus offset |
| `intro.start`, `intro.end` | Position enters or leaves an intro marker (episodes) |
| `playback.buffering` | Session state is buffering |
| `session.ended` | Stop was not followed by new playback within the stop hold (1 s partway through an item) |
| `session.seek` | A position jump larger than expected was detected |

## Playback engine

One state machine per player:

```
idle -> playing <-> paused
          |  ^
          v  |        (buffering is treated as playing)
       in credits
any -> stopping --(hold elapsed)--> idle   (new playback during the hold cancels it)
```

### Stop hold

The hold depends on where playback stopped, because only a stop at the end can be followed by autoplay:

- **Near the end** (in or past the first credits, in the final 10% of the runtime, or within 60 s of the end): the
  full stop hold, 10 s by default, so the next episode or the movie after a cinema trailer never passes through
  Nothing Playing. An unknown position or runtime counts as near the end, except for Live TV.
- **Anywhere else:** 1 s (or the stop hold, if that is shorter). Enough for players that report stopped and playing
  again within milliseconds, short enough that leaving a movie brings the lights up promptly.

The position used is the estimate at the moment of the stop, which is also frozen as the stop event's position.

### Session lookup

A notification carries no player name or item details, so the first one for a new item triggers a read of
`/status/sessions`. If Plex doesn't list the session yet, the read is retried twice, 1 s apart. The webhook for the
same play usually arrives within 100 ms and supplies the session, which ends the wait. Only after the retries does the
engine use a placeholder (player ID, no title), and the next webhook for that item replaces it and sends `play` again
so sensors re-check their filters. Before this, a placeholder made sensors filtered by player treat a real playback
as Nothing Playing until the item stopped.

### Credits timing

1. On play, resume or any new position (webhook `viewOffset`, server notification, or a read), the engine stores
   `position` and `observedAt`. While playing, current position is `position + (now - observedAt)`.
2. It schedules a timer for `creditsStart + offset - currentPosition`.
3. Every `playing` notification (every 10 s, and immediately after a seek) re-arms the timer from the reported position.
   Only if the notification stream is down does the engine fall back to one session read shortly before firing
   (pre-fire verify lead, default 20 s, minimum 12 s).
4. At fire time it emits `credits.start`.
5. **Latch:** once in credits, the state stays in credits unless position moves back more than the re-arm distance
   (default 60 s) before the marker. This prevents a fade-up, fade-down, fade-up flicker when resume rewinds
   the position a few seconds before the credits.
6. If a movie or episode has no credits marker, 95% of its duration is used instead (adjustable or off). Music, photos and clips never get one.

Markers are cached per item. A "no marker" result is re-checked after 6 hours, on `library.new`, or on the next play,
so markers generated later are picked up without a restart.

### Sources and read budget

Playback state and position come from the **server notification stream** (push, no Plex Pass). **Webhooks** add what
the stream lacks: user, library and full metadata on play, plus every non-playback event. Each `playing` notification
re-arms the credits timer, so seeks and skips are handled the moment they happen, with no polling.

| Moment | Reads from Plex |
|---|---|
| New session (first notification or `media.play`) | 1 session read for player, user and library, skipped when a webhook already supplied them |
| New item | 1 marker read, cached |
| Homebridge start | 1 session read to restore state |
| Notification stream connected | Nothing else |
| Notification stream disconnected | Fallback: pre-fire verify and the safety re-sync (Advanced settings) until it reconnects |

The stream reconnects with backoff. The Live tab and the header show its status.

## HomeKit outputs

Each sensor the user creates is one HomeKit accessory:

- **State sensors** are Occupancy (default), Motion or Contact sensors. They are on while a condition is true.
  Conditions: Playing (before credits), Playing (any), Paused, In credits, Any session active.
- **Event triggers** are Stateless Programmable Switches. One "press" per event, which Home automations can trigger on.
- An **Intermission** switch turns all automations' triggers off temporarily (for example during a party).

Every sensor has optional filters. Within a filter group the values are OR; across groups they are AND.

| Filter | Values |
|---|---|
| Players | From the account and server history |
| Users | Owner, Plex Home users, shared users |
| Libraries | From the selected server |
| Media types | Movie, Episode, Clip, Track |
| Conditions | Has credits marker, Local or remote player |

### Suggested setups

All three use state sensors only (see the lab results below).

| Option | Sensors | Behaviour |
|---|---|---|
| 1. Simple | Media Playing (playing, including credits) | On while anything plays; off on pause and stop |
| 2. Simple + Credits (recommended) | Media Playing (playing, except during the credits) | Also off during the credits, on again for a mid-credits scene |
| 3. Every State | Media Playing, Media Paused, Credits Rolling, Nothing Playing | Exactly one on at a time; each state gets its own automation |

"Paused" means paused outside the credits, so a pause during the credits keeps Credits Rolling on and exactly one sensor
is on at any moment. `tools/reliability-lab/scene.mjs` checks this end to end through HAP.

Mid-credits scenes come from Plex's credits markers: a movie with a scene has two credits markers with a gap between
them. By default credits follow every marker, so the gap counts as playing. Advanced can instead run the credits from
the first marker or from the final one. Rewinds within the re-arm distance never change the credits state, so the
15-second rewind on resume does not flick the lights at a boundary.

Filters: the chosen players and people, with every Movies and TV library preselected on each server.

People: **All Plex Home users** (the default, no user filter) or specific users from `plex.tv/api/home/users`.
Libraries are listed per server and stored as `serverId/sectionId`. Music, Photos and Other Videos can be chosen; they
never get a credits event, so their sensors simply follow play, pause and stop.

### Sensors and buttons: lab results

`tools/reliability-lab` runs the plugin in a real Homebridge against a simulated Plex server, with a real HAP
controller as the hub and modelled Home automations driving virtual lights. Scripted run, 20 checks after each
situation settled:

| Rig | Right | Fails |
|---|---|---|
| A. Buttons only | 14/20 | hub offline at a pause; rewind out of the credits (no event to bring lights down); playback resumed while Homebridge restarted; credits fade kept running into the next episode (a shortcut can't stop another) |
| B. Sensors only | 20/20 | none |
| B2. Sensors, hub ignores changes seen on reconnect | 15/20 | the hub-offline and restart cases, until the next change |
| C. One sensor and three buttons | 18/20 | missed pause and missed credits while the hub was offline |

A randomised run (40 rounds of pauses, skips, credits jumps, rewinds, autoplay and hub outages) scored 38/40 for
buttons and 39/40 for every sensor rig; the one miss shared by all was a check during a fade.

Stutter was the same for every rig: quick pause/resume bursts and skips produced no light changes at all, because the
engine's debounce and credits latch absorb them before HomeKit sees anything. HAP-NodeJS also delivers every distinct
sensor value (it coalesces only identical repeats within 250 ms), so sensors do not filter stutter by themselves.

Plugin changes from the lab: sensors restore their last state after a restart until Plex has been read; state changes
are published before button presses, offs before ons.

### Sensors and buttons in HomeKit

- **State sensors** have a value Home can read: an automation can trigger on a change *and* use the state as a condition,
  and a shortcut can read it (the ramp's cancel check). Occupancy, Motion and Contact behave the same here; they differ in
  how Home presents them (Motion can send notifications; Contact reads as open/closed).
- **Buttons** are momentary: Home can trigger on a press but cannot test one later. Each button can run its own scene.

## Fades in Apple Home

HomeKit has no transition-time setting, and native fade rates differ by brand and cannot vary per event.
Per-event fades are built in Home as automations converted to shortcuts: Repeat N times, set brightness up a step,
Wait. The ramp checks **Credits Rolling** each step and stops once it is no longer detected. The Recipes tab gives step-by-step
recipes. The plugin cannot create Home automations; only Apple Home can.

## Settings

The Advanced page has **Reset to defaults** and the note "These rarely need changing."

| Setting | Default | Range |
|---|---|---|
| Credits offset | 0 s | 0 to 120 s (never before the marker) |
| Mid-credits scenes | Dim for the scene | Or lights up from the first credits, or down until the final credits |
| Fallback when a movie or episode has no credits marker | 95% (with or without Plex Pass) | Off, or 50 to 99% of duration |
| Pre-fire verify lead (only when the notification stream is down) | 20 s | 12 to 120 s |
| Safety re-sync while playing (only when the notification stream is down) | 5 min | Off, 1 to 30 min |
| Credits re-arm distance | 60 s | 20 to 600 s |
| Pause debounce | 1.5 s | 0 to 30 s, in 0.5 s steps |
| Stop hold (near the end of an item) | 10 s | 0 to 60 s; stops elsewhere count after 1 s |
| Minimum item length | 0 min | 0 to 60 min |
| Restore state on start | On | On or off |
| Refresh from Plex | Every 24 h | 6 to 168 h |
| Detailed logging | Off | On or off |

## Plex server settings

Read during the health check and shown in plain language:

| Pref | Meaning | Used for |
|---|---|---|
| `GenerateCreditsMarkerBehavior` | Credits detection (`never`, `scheduled`, `asap`) | Required for the credits trigger |
| `GenerateIntroMarkerBehavior` | Intro detection | Intro events |
| `LibraryVideoPlayedThreshold` | Played threshold, 70 to 95% | Predicting when scrobble arrives |
| `LibraryVideoPlayedAtBehaviour` | Completion behaviour (0 to 3) | Predicting when scrobble arrives |
| `WebHooksEnabled` | Server webhooks switch | Required for webhooks |
| `MarkerSource` | Online, local or both | Shown for troubleshooting |

The credits trigger uses markers directly, so it does not depend on the scrobble settings. The plugin offers to change
`WebHooksEnabled` or `GenerateCreditsMarkerBehavior` only when they block a feature, and only after the user approves the change.

## Plex Pass

Webhooks and credits detection both require Plex Pass on the server owner's account. The plugin works either way:
playback comes from the server notification stream, which needs no Plex Pass.

### Capabilities, not modes

Every event and condition is tagged **works without Plex Pass** or **needs Plex Pass**. Sensors are never deleted,
renamed or rewired when Plex Pass status changes, so Home automations keep working. A sensor that uses a Plex Pass
event while Plex Pass is unavailable stays in HomeKit and simply does not trigger; the board marks it with a
"Needs Plex Pass" badge.

| Feature | With Plex Pass | Without Plex Pass |
|---|---|---|
| Pause, resume, stop, buffering, seeks | Instant | Instant (notification stream) |
| Playback start | Instant (`media.play` webhook) | At the player's first report, up to 10 s after pressing play (measured) |
| Player, user and library of a session | From the webhook, instantly | One session read when the session starts |
| Credits trigger | Credits markers, then the percentage fallback | Markers already on the server, then the percentage fallback |
| New credits markers for new media | Generated by the server | Not generated |
| `media.scrobble`, `media.rate`, `library.new`, `library.on.deck`, owner events | Available | Not available |

### Detecting Plex Pass

The subscription is read from `plex.tv/api/v2/user` (`subscription.active`) at sign-in, on Homebridge start, on the
24-hour Plex refresh and whenever the settings page opens. Evidence also triggers a re-check: if the notification stream
shows playback starting but no matching webhook arrives within 15 s, three times in a row, the plugin re-checks the subscription.

### Without Plex Pass at sign-in

The health check explains, in plain language, what works and what is limited (the table above). Setup continues
normally, with the percentage fallback turned on. Plex Pass features are shown but disabled, each with a one-line reason.

### Plex Pass added later

Everything that needs no change to the user's Plex account turns on automatically: Plex Pass events become available
in the palette, and credits markers are used as the server generates them.

Registering the webhook changes the user's Plex account, so it is offered rather than done silently:
- **Settings page:** a banner reads "Plex Pass detected: turn on instant play detection and more events". One tap shows
  the webhook change for approval.
- **Log:** one line points to the settings page.
- **Existing setup:** nothing changes. The fallback stays on as a safety net for items without markers.

### As built

- Plex Pass is read at sign-in, on Homebridge start, once a day and whenever the settings page opens. The last status
  is kept in `plex-pass.json`; a change is shown on the settings page until dismissed, and logged once.
- Without Plex Pass the webhook receiver is not started; when Plex Pass returns it starts without a restart.
- The percentage fallback for missing markers applies with or without Plex Pass (movies and episodes only; not Other
  Videos), so nothing about credits needs to switch over.

### Plex Pass ends

1. Detected by the daily check or the missing-webhook evidence.
2. The plugin keeps running on the notification stream. Playback sensors keep working; play start becomes up to 10 s slower.
3. Sensors that depend on Plex Pass events pause, with a badge. Credits keep working for items that already have
   markers, and the percentage fallback is turned on for the rest. The user's previous fallback setting is remembered
   and restored if Plex Pass returns.
4. **Notice:**
   - **Log:** one warning line.
   - **Settings page:** a banner on the next open, kept until dismissed: "Plex Pass ended (detected Oct 30). Intermission
     switched to basic playback detection." Below it, what still works, what changed and which sensors are paused,
     with **Re-check** and **Dismiss** buttons.
5. If Plex Pass returns and the Intermission webhook is still registered, everything resumes automatically, with one log
   line. If the webhook is gone, the "Plex Pass detected" offer appears again.

### Needs attention sensor (optional)

An optional contact sensor opens when the plugin needs the user. Reasons: Plex Pass ended, sign-in expired, or the
server has been unreachable for 10 minutes. With Home app notifications turned on for it, the user hears about problems
without opening Homebridge. Off by default.

## Sign-in and discovery

- **Sign in with Plex:** the plugin creates a PIN (`POST plex.tv/api/v2/pins?strong=true`), opens Plex's sign-in page
  in a popup and polls the PIN until it carries a token.
- **Code fallback:** a 4-character code entered at plex.tv/link.
- **Token paste** is available under Advanced.
- **Server:** listed from `plex.tv/api/v2/resources`; chosen automatically when there is only one. The local connection is preferred.
- **Players:** the union of account devices (`plex.tv/devices.xml`), server devices and play history (`/devices`,
  `/status/sessions/history/all`) and live sessions, ranked by last use. "Press play on a device to highlight it"
  identifies a device live through the incoming event.
- **Users and libraries:** read from plex.tv and the server.
- **Refresh from Plex:** a header button, on Homebridge start, every 24 hours, and when `device.new` or `library.new` arrives.

## Webhook registration

Uses the undocumented `plex.tv/api/v2/user/webhooks` endpoint that Plex Web uses.

1. The plugin reads the current list and shows it.
2. It explains the proposed change and asks for approval. Existing webhooks are kept. An old Intermission URL is
   offered for replacement. No other entry is removed unless the user explicitly selects it.
3. The fallback is copying the URL, with instructions for adding it in Plex.

Until it is confirmed whether a POST replaces the whole list, the plugin always sends the full list. After the change it re-reads
the list; if any existing webhook went missing, it writes the full list again. Setup shows this as its own step after
choosing servers, with a red minus beside each existing webhook so old ones can be removed in the same change.

The address ends in a random key made per install. The receiver ignores any request without it and answers a GET on
that path with `{"app":"intermission"}`, so the settings page can tell whether the port is free, used by Intermission,
or taken by another app (in which case it asks for another port).

### Sign-in lifetime

Homebridge keeps a plugin's storage folder when the plugin is removed. The credentials therefore carry a `setupId` that
is also written to the plugin's config at sign-in. A config without the matching id (a fresh install) means the saved
sign-in is left over: the settings page erases it and the platform ignores it. When a server's Webhooks setting
(`WebHooksEnabled`) is off, the same approval also turns it on. The address is this machine's IPv4 address on the
server's subnet, or the "Homebridge address for Plex" override in Advanced.

**Endpoint security:**
- A random 128-bit secret path. Requests to any other path are rejected.
- The bind address is configurable.
- An optional allowlist limited to the Plex server's IP.
- A body size limit.
- The payload's server identifier must match the selected server.

## Credentials

- The token is stored at `<Homebridge storage>/intermission/credentials.json`, with the file at mode 0600 and the folder at 0700.
- It never appears in `config.json`, the accessory cache, logs or debug reports.
- The settings UI receives only "signed in as" information, never the token.
- Signing out deletes the file. A 401 from Plex prompts the user to sign in again.
- Encrypting the token with a key stored on the same disk would add no real protection, so file permissions are the control.

## Settings UI

- **Look:** Homebridge-native and following light or dark mode, with a subtle warm amber accent taken from the icon.
- **First run:**
  1. Sign in.
  2. Server, chosen automatically when there is only one.
  3. Health check: Plex Pass, webhook with "Add for me", credits detection with coverage per library.
  4. Choose players, users and libraries.
  5. A suggested setup (Simple, Simple + Credits or Every State) or "Start from scratch."
  6. The board.
- **Tabs:** Sensors (the board), Live, Recipes & Notes, Advanced, Diagnostics.
- **Header:** account and server, a webhook status dot with the time of the last event, and Refresh.
- **Board:**
  - Sensor cards with a plain-language summary.
  - A palette of chips: Events, Players, Users, Libraries, Media types, Conditions.
  - Drag on desktop, tap to add everywhere, full keyboard support.
- **Live tab:** recent events, which sensors each event matched and why, and test-fire buttons.
- **Tech:** plain ES modules with a small touch-capable drag library. No heavy framework.

### Device icons

Small, friendly icons identify players and servers in the wizard, palette and Live tab
(`homebridge-ui/public/device-icons.js`). Generic shapes only, no brand logos. Strokes use `currentColor` so they follow
the Homebridge theme, with warm accents from `--im-accent`.

| Icon | Matched from Plex `product`, `platform` and device model |
|---|---|
| Streaming box with remote | tvOS, Apple TV |
| Streaming box | Roku, NVIDIA Shield, Fire TV Cube, Google TV Streamer |
| Streaming stick | Fire TV Stick (`AFT*` models), streaming sticks |
| Smart TV | webOS (LG), Tizen (Samsung), Vizio, Hisense, Sony Bravia, Android TV |
| Phone, Tablet | iOS and Android phones, iPad and tablets |
| Computer, Desktop | Plex for Mac or Windows; Plex HTPC |
| Web browser | Plex Web in Chrome, Safari, Firefox or Edge |
| Game console | Xbox, PlayStation |
| Music player | Plexamp |
| Speaker | Sonos, Alexa |
| Cast device | Chromecast, Google Cast |
| VR headset | Meta Quest, Vision Pro |
| Car | Android Auto, CarPlay |
| Plex Media Server | Servers |
| Player (default) | Anything not recognised |

## Logging and diagnostics

**Normal log** (what a user watches): startup summary, connection to each server, webhook receiver listening, every
sensor turning on or off with what was playing ("Credits Rolling: on (Dune: Part Two, Living Room)"), button presses,
commands run or failed, Plex Pass changes, and errors with what to do about them.

**Detailed logging** (Settings, Advanced) adds, at info level in the Homebridge log:
- each change Plex reports per player (state, position, item);
- each playback event with title, player and position;
- per item: credits ranges and why (markers and mode, the percentage fallback, or no credits because of the library,
  media type or Live TV) and intro ranges;
- for each state sensor when an item starts, whether it follows this playback or why not (player, person, library,
  media type or a media condition), repeated for media conditions once the item's details are read;
- pauses ignored by the pause debounce, the stop hold starting (near the end, or partway through and the 1 s hold),
  "the next item started within the stop hold", and session lookups retried because Plex didn't list the session yet;
- the startup decision (sensors keep their pre-restart state until Plex is read, or 20 s pass);
- webhooks received, media details read, and command lines.

**Kept log.** Whatever the setting, everything above (debug included) is also written to `intermission/diagnostics.log`
in Homebridge's storage, rolling to `diagnostics.1.log` at about 1 MB (roughly a day of use), owner-readable only.
Titles, people, players and command lines are written with invisible markers; Homebridge's log shows them as plain
text.

**Diagnostics** (Settings): one text file for a bug report with the setup report, every sensor (conditions, filters,
media conditions, commands), command names, and the last 6,000 kept log lines. Before it leaves the plugin, account
and server tokens, the webhook key and `X-Plex-Token` values are removed, public IPv4 addresses (and public
`plex.direct` names) become `x.x.x.x`, and marked values become "Title 1", "Person 1", "Player 1" and "(command line
hidden)" unless "Include titles and names" is ticked. Download, Copy and Show; Copy is the fallback if the settings
frame blocks downloads. The footer's "Report a bug" walks through: download diagnostics soon after the problem, open
the bug report, attach the file.

## Lifecycle

Homebridge's verification checks start the plugin with no configuration, with only the platform configured and with a
full configuration, then stop it with SIGTERM and start it again. So:

- Nothing runs until the platform is configured and signed in.
- On the `shutdown` event the plugin closes the webhook server and the notification websocket and clears its timers,
  well within the 12-second limit.
- A webhook port already in use is logged as a clear error with the port number. The plugin keeps running on the
  notification stream instead of crashing.
- All errors from Plex, the network and timers are caught and logged; none escape as unhandled rejections.
- No environment variables are read in plugin code. Settings come from the config, and the token from the storage file.

`test/runtime.test.js` runs the first two checks and the shutdown timing in CI.

## Attribution

The credits-aware approach comes from [homebridge-plex-credits](https://github.com/DavidD303/homebridge-plex-metadata/tree/credits-aware-playback)
by DavidD303, a fork of [homebridge-plex-metadata](https://github.com/davidmuzi/homebridge-plex-metadata) by davidmuzi.
Both are MIT licensed.

## Open questions

- Does a POST to `plex.tv/api/v2/user/webhooks` replace the whole list?
- "Stop this shortcut" is offered in the Home app's shortcut editor (seen Oct 2026). Still to confirm: does it end the run early when a home hub runs the automation?
- Which endpoints list Plex Home and shared users?
- Does the server's `/accounts` name always match the user title in sessions and webhooks? User filters compare names.

## Build status

| Part | State |
|---|---|
| Engine, Plex client, notification stream, webhook receiver | Done, tested with recorded playback |
| Sensors, controller, platform wiring | Done |
| Sign-in, several servers, discovery, wizard, board, Recipes, Advanced | Done (tap to edit, drag to reorder) |
| Webhook "Add for me" with review, "About this setup" report | Done |
| Plex Pass change notices, Diagnostics export, Now playing panel in the sensor editor (instead of a Live tab) | Done |
| Guide: presets in use shown first, the others folded | Done |
| Guide screenshots of the Home app (automation, Convert To Shortcut, shortcut steps, Every State) | Done (`homebridge-ui/public/guide`, WebP, about 130 KB) |
| Intermission switch (turns all triggers off for a while) | Not built |
| npm release (`private: true` removed) and Homebridge verification | Not started |

## Sensor conditions

A state sensor has one condition and, for Playing, Paused and Playing or paused, optional exceptions:

| Condition | Exceptions | Used by |
|---|---|---|
| Playing | none, credits, intro | Simple (none); Simple + Credits and Every State (credits) |
| Paused | none, credits | Every State (credits, so a pause during the credits stays "In the credits") |
| Playing or paused | none, credits, intro | |
| In the credits | | Every State |
| In the intro | | |
| Nothing playing | | Every State |

Every preset is just these settings, so anything a preset makes can be built from scratch or turned into anything else
in the editor. "What counts as the credits" (mid-credits scenes count as playing, the default; mid-credits scenes count as credits; final
credits only) is one setting shared by every sensor, because sensors that follow the credits must agree: with a
per-sensor choice, "Playing except the credits" and "In the credits" could both be off during a mid-credits scene, and
Every State could have two sensors on. The choice is shown in the editor of every sensor it affects, labelled as
shared, and in Settings.
Older configs are read with their old meaning: `playing-any` becomes Playing, and `playing` and `paused` without
`except` leave out the credits.

Intro detection uses Plex's intro markers (found on servers with Plex Pass, mostly for TV episodes), read in the same
request as the credits markers. Skip Intro is a seek past the marker and ends the intro at once.

## Commands

Off by default. Settings, Advanced, Commands turns them on; each command has a name and a shell line. Sensors then
show "Run commands when it turns on / off", and buttons "when pressed". Commands run on the Homebridge machine (inside
the container under Docker) with a 30-second limit, from the plugin itself, so they don't depend on the Home hub.
`{title}`, `{type}`, `{library}`, `{player}`, `{user}`, `{sensor}`, `{state}` and `{event}` are filled in and shell-quoted,
so a title can't change the command. Settings has a Test button that runs a command once with sample values.

## Settings tab

- **Your setup:** servers, players, people and libraries, with "Change servers, players and libraries" and sign out.
- **Credits:** Credits behavior and the no-marker fallback.
- **Plex Pass and webhooks:** status and webhook list; "Webhook options" (receive, port, address) collapsed.
- **Advanced** (collapsed): timing, detailed logging, commands.
- **About this setup.**
- **Reset** (collapsed): "Reset all settings" and "Reset Intermission".

## Presets after setup

The Sensors tab has "Add preset", and each preset in the Guide has "Add this preset". On an empty board the preset is
added at once. Otherwise the user chooses:

- **Add alongside** (default): existing sensors stay; a preset sensor whose name is taken gets " 2", " 3"...
- **Replace them** (second tap to confirm, with a warning that automations using removed sensors stop working): a
  preset sensor with the same name as an existing one takes over that sensor's id, filters and commands, so its Home
  automations survive.

Only Every State is grouped (`group: "states:<id>"` on its sensors), because its sensors depend on each other: the
board shows them under one header with "Remove set", and a note when the set was edited so that more than one sensor
(or none) could be on. Single-sensor presets are ordinary sensors once added.

## Live TV

Detected per server from `/media/providers`: a provider with the `livetv` protocol or an EPG identifier
(`tv.plex.providers.epg.*`). This works for shared servers, where `/livetv/dvrs` may be hidden. Discovery lists it as a
"Live TV" library (`serverId/livetv`, kind `livetv`), not chosen by default. Sessions with `live="1"` get section
`livetv`, so library filters work unchanged; "All libraries" includes it. Live TV never gets credits: no marker read,
and no percentage fallback (Plex only knows the scheduled length).

## Media conditions

State sensors can have conditions on what is playing, under "Only when the media is…" in the editor: picture shape
(wide is 2.2:1 or wider), resolution (4K, HD, SD), HDR (HDR includes Dolby Vision; Dolby Vision; SDR), content rating
and labels (any of; an episode also uses its show's labels). Every set group must match.

- **Source:** `/library/metadata/{id}` (and the show for an episode), not the session, so values describe the file and
  never change when Plex starts or stops transcoding. Read once per item, only when some sensor has conditions, and
  cached. The sensor turns on a moment after play starts, once the read finishes.
- **Unknown values fail.** A sensor with conditions stays off for media Plex can't describe, including Live TV.
- **Now playing panel:** in the editor, "Show what's playing now" lists current sessions with their details and a
  "+ condition" next to each. Raw Plex attributes are not offered as conditions: names and formats vary by version and
  client, and a condition on an undocumented field breaks silently.
- Buttons have no media conditions (a press can't wait for the read).
- Picture shape comes from Plex's `aspectRatio`. A letterboxed 2.39:1 film encoded as 16:9 reports 1.78; a Plex label
  such as "Scope" is the reliable option for those files.

## Child bridge

The last setup step offers "Run Intermission on its own bridge", on by default and only at first setup (no sensors
yet): moving sensors between bridges later re-creates them in Apple Home and breaks automations. Finishing setup
writes `_bridge` as Homebridge's own "Use Child Bridge" does: a random, locally administered MAC-style `username`, a
fixed `port` from 51000 to 56999 (never 51826) and `name: "Intermission"`. The pairing code is the main bridge's PIN,
as with any child bridge.

After the restart, the Sensors tab shows "Add Intermission to the Home app" with the QR code and the code until the
bridge is paired. Both come from HAP-NodeJS's own record of the bridge (`persist/AccessoryInfo.<id>.json`: pincode,
setupID, category, paired clients); the setup URI is computed the same way as `Accessory.setupURI()` (checked against
it in the tests) and drawn with `qrcode-generator` (MIT, no dependencies). "Reset Intermission" keeps `_bridge`, so the
bridge already in the Home app is reused. Verified in a real Homebridge 2.4: the generated config starts a child
bridge, the code read from storage pairs a HAP controller, and the sensors appear on that bridge.

## Restart banner

At start the plugin writes `running.json` with a fingerprint of the config block it loaded (keys sorted; Homebridge's
own `_` keys left out). The settings page fingerprints the saved config the same way (`/runtime`) and shows:

- "You have unsaved changes. Click Save, then restart Homebridge" while the page has changes Save hasn't stored.
- "Restart Homebridge to apply your saved settings" when the saved config differs from the running one.
- "Intermission is set up. Restart Homebridge to start it" when the plugin has never run.

The webhook port dot is amber while a restart is due, green when Intermission answers, and red when another app holds
the port or the running plugin isn't listening.
