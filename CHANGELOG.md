# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-11-06

### Added

- Players are chosen by device. Choosing the Apple TV includes every Plex app on it, including apps added or reinstalled
  later, while it plays on your home network. *Choose apps* lists the apps seen on a device, to leave one out.
- Two devices that report the same name (apps see "Apple TV" for every Apple TV) are noticed, with a log warning, and
  setup offers *This one* to keep only the one in the room. You can name devices.
- Diagnostics: a Network check saying whether Plex sees players' real addresses and marks them local, devices and apps
  left out on each sensor, and each player's platform.

### Changed

- Choices made app by app move to devices when the settings page opens. Apps that weren't chosen are left out, so
  nothing new changes the lights; press Save to keep it.
- A player is at home when Plex marks it local or its address is private, so Plex in a Docker bridge network without
  LAN Networks set still works.
- Addresses shared by players on different platforms are never used to tell devices apart or follow new IDs.

## [1.0.2] - 2026-11-06

### Fixed

- A player that Plex gives a new ID, after its app is reinstalled or signed in again, keeps changing the lights. When
  its name, app and LAN address match a chosen player, the sensors follow it as that player and the log says so.
- A player that only shares a chosen player's name gets a warning in the log instead of being silently ignored.

### Changed

- The Sensors tab offers to add a player with a new ID to the sensors that watch the player it replaces, or to leave it
  off.
- Setup: players that share a name show when each last played and the start of its ID, and apps Plex lists without a
  name show the app Intermission saw them play as.
- Diagnostics lists the players seen playing, with their app, last play and whether they are chosen or followed.

## [1.0.1] - 2026-10-23

### Fixed

- Players added later with *Change servers, players and libraries* now reach the sensors. Sensors that watched exactly
  the old choices of players, people or libraries follow the new ones; filters set by hand stay as they are.
- Sensors saved before this fix that leave out a player chosen in setup get a notice on the Sensors tab, with *Add to
  the sensor* or *Leave as is*.

### Changed

- Players with the same name, such as Plex and Infuse on one Apple TV, are shown with their app (or the start of their
  ID) in sensor summaries, filters, the diagnostics file and the log.
- Saved players take Plex's current name and app when setup runs again.
- Diagnostics: the log is newest first, and *Watch live* shows the log as it happens, in local time and with names,
  without downloading anything.

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

[Unreleased]: https://github.com/maxrogers/homebridge-plex-intermission/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/maxrogers/homebridge-plex-intermission/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/maxrogers/homebridge-plex-intermission/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/maxrogers/homebridge-plex-intermission/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/maxrogers/homebridge-plex-intermission/releases/tag/v1.0.0
