# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

Initial development.

### Added

- Playback engine: play, pause, resume, stop, seek and credits events from Plex notifications and webhooks, with no polling.
- HomeKit sensors: occupancy, motion and contact sensors for playback states, and buttons for events, each filtered by
  player, user, library and media type.
- Plex sign-in from the settings page (browser or plex.tv/link code), server selection and discovery of players, users
  and libraries.
- Setup wizard with suggested setups, a sensor board, Recipes & Notes, and Advanced settings with reset.
- Several Plex servers at once, with libraries listed per server.
- People: All Plex Home users, or specific Plex Home users.
- Webhook "Add for me": shows the account's current webhooks for review, keeps them, and turns on the server's Webhooks
  setting if needed.
- "About this setup" report on the Advanced page.
- Setup step for Plex Pass and webhooks right after choosing servers: Plex Pass status, each server's Webhooks
  setting, the webhook port, and the account's webhooks with a remove button for each.
- The webhook port is checked: free, used by Intermission, or used by another app.
- A saved sign-in is tied to the plugin's config, so removing the plugin and its config means the next install starts
  signed out.
- "All" options for players, people, libraries and media types.
- Sensor type choice with Occupancy marked as recommended.
- Three suggested setups, all state sensors (chosen after testing buttons and sensors against a real Homebridge, a HAP
  controller and a simulated Plex server): Simple (one sensor), Simple + Credits (one sensor that also turns off for the
  credits and back on for a mid-credits scene) and Every State (Media Playing, Media Paused, Credits Rolling, Nothing
  Playing).
- Mid-credits scenes: credits follow every credits marker by default, so a scene between them dims the lights again.
  Advanced can instead start the credits at the first or the final marker.
- "Nothing playing" sensor condition.
- Plex Pass is re-checked daily and whenever the settings open. When it ends or starts, the log says so and the
  settings page shows a notice until dismissed; webhooks start on their own when Plex Pass returns.
- Advanced has separate, confirmed "Reset advanced settings" and "Reset Intermission" (signs out, removes the webhook,
  sensors and settings, then setup starts again).
- Changing servers later keeps choices and sensors consistent: libraries of removed servers are dropped, new servers'
  libraries of the same kinds are added, and nothing is saved until the last step (Cancel leaves everything as it was).
- Fixed: "Change servers, players and libraries" failed for anyone already set up.
- Sensor conditions are now a state plus optional "except during the credits / the intro"; older configs keep their
  meaning. The editor shows Credits behavior next to sensors it affects.
- Intro detection from Plex's intro markers: "In the intro" condition, intro exceptions, and intro start/end events.
- Commands: named shell commands run when a sensor turns on or off or a button is pressed (off by default).
- Preset 2 is now "Simple + Credits". Advanced is now "Settings", with collapsible Webhook options, Advanced and Reset.
- "Recipes & Notes" is now "Guide", with a section per suggested setup and ideas for Every State.
- "Mid-credits scenes" is now "Credits behavior", noting it only affects credits-aware sensors.
- A library added later (including Other Videos) is recognised the first time something plays from it.
- Media types are no longer a sensor option: each library's type decides. Movies and TV get credits handling; Music,
  Photos and Other Videos follow play, pause and stop only.
- "Paused" now means paused outside the credits; a pause during the credits stays "In the credits". With Every State
  exactly one of the four sensors is on at any moment, including through a mid-credits scene.
- Sensors keep their state across Homebridge restarts until Plex has been read, so lights don't jump on restart.
- State changes are published before button presses, offs before ons, so automations never see two states at once.
- "Credits behavior" is now "What counts as the credits": Mid-credits scenes count as playing (default), Mid-credits scenes count as credits,
  Final credits only. Shown under any sensor that follows the credits, labelled as shared, as well as in Settings.
- Add preset on the Sensors tab and "Add this preset" in the Guide: add alongside existing sensors, or replace them
  (same-name sensors keep their Home automations). Every State is shown as a group with "Remove set".
- Live TV: listed per server when the server has a tuner or DVR, not chosen by default, never gets credits.
- Media conditions: a state sensor can require a picture shape, resolution, HDR, rating or labels, read from the
  library item when play starts. The editor's Now playing panel shows what Plex reports, with "+ condition".
- Restart banner: the settings page says when changes are unsaved or saved but not running yet. The webhook port dot
  is amber while a restart is due and red when nothing is listening.
- The Guide starts with Good to know, then a Presets section and ideas beyond the presets.
- Commands show a short safety note; the name field example is "Projector Control".
- Fixed: renaming a sensor now renames the cached accessory too (`updateDisplayName`).
- Fixed: "Remove Intermission webhook" did nothing when it was the only webhook on the account; removal is now
  checked, and an error says so if Plex keeps it.
- The log shows every sensor turning on or off with what was playing, and when the webhook receiver starts listening.
- Detailed logging explains decisions: why a sensor follows or ignores a playback, why an item has no credits, intro
  ranges, pause debounce, stop hold and autoplay, and the startup state.
- Diagnostics in Settings: a downloadable text file with the setup, sensors and the recent detailed log, which the
  plugin always keeps. No sign-in, tokens or webhook key; public addresses hidden; titles, people, players and command
  lines replaced unless included. "Report a bug" links to it.
- Without Plex Pass, the summary and the intro hint say that only items with existing intro markers have an intro.
- Except during: "Credits" and "Intros"; "Mid-credits scenes count as playing / as credits"; "Plex labels".
- Credits fall back to 95% of the runtime for movies and episodes without a marker, with or without Plex Pass.
  Music, photos and other videos never get a credits event.
