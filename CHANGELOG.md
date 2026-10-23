# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-10-23

First public release.

### Playback

- Follows Plex through the server's push notifications and, with Plex Pass, webhooks, using whichever arrives first.
  No polling.
- Credits from Plex's credits markers, re-timed on every skip and rewind. Movies and episodes without a marker use 95%
  of the runtime, or no credits if you turn the fallback off.
- What counts as the credits, one setting for every sensor: mid-credits scenes count as playing (default), as credits,
  or only the final credits count.
- Intros from Plex's intro markers.
- Pauses under 1.5 seconds and Apple TV skip bursts change nothing.
- A stop partway through counts after 1 second. A stop in the credits or near the end waits 10 seconds for autoplay,
  so the next episode, or the movie after a cinema trailer, never passes through Nothing Playing.
- Sensors keep their state across Homebridge restarts until Plex has been read.
- Works without Plex Pass, with play noticed at the next progress report. Plex Pass is re-checked daily; when it
  starts or ends, the log and the settings page say so.

### Sensors

- Occupancy (recommended), motion and contact sensors that are on while something plays, is paused, is in the
  credits or intro, or while nothing plays, with optional exceptions for the credits and intros.
- Buttons for one-off events, including the Plex Pass webhook events.
- Filters by player, person and library, including Live TV.
- Media conditions: picture shape, resolution, HDR, rating or Plex labels, read from the library item.
- Presets: Simple, Simple + Credits and Every State (exactly one of four sensors on at a time).
- Several Plex servers at once.
- Optional commands, run when a sensor turns on or off or a button is pressed.
- Runs on its own child bridge by default.

### Settings page

- Sign in with Plex, in a browser window or with a plex.tv/link code.
- Setup in four steps: servers, Plex Pass and webhooks, players, people and libraries, then a preset.
- Webhook setup that shows the account's existing webhooks, keeps them, and turns on the server's Webhooks setting.
- A Guide with the Home automations for your presets, fade recipes made with Convert To Shortcut, and screenshots.
- Diagnostics: one text file with the setup, the sensors and Intermission's recent log, without the Plex sign-in,
  tokens, webhook key or public addresses, and with titles and names replaced unless you include them.
- Reset all settings, or reset Intermission completely.

### Troubleshooting

- The log shows every sensor change with what was playing; Detailed logging adds every Plex report and decision.
- Intermission keeps its own detailed log whatever the setting, so a problem can be reported without reproducing it.
- The diagnostics file records the time zone, whether saved settings are running, and whether the bridge is in the
  Home app.
- Lost connections to Plex are retried with their reasons logged, with a warning if Plex stays unreachable.

[Unreleased]: https://github.com/maxrogers/homebridge-plex-intermission/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/maxrogers/homebridge-plex-intermission/releases/tag/v1.0.0
