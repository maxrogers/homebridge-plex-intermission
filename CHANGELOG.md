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
  controller and a simulated Plex server): Simple (one sensor), Credits-Aware (one sensor that also turns off for the
  credits and back on for a mid-credits scene) and Every State (Media Playing, Media Paused, Credits Rolling, Nothing
  Playing).
- Mid-credits scenes: credits follow every credits marker by default, so a scene between them dims the lights again.
  Advanced can instead start the credits at the first or the final marker.
- "Nothing playing" sensor condition.
- Sensors keep their state across Homebridge restarts until Plex has been read, so lights don't jump on restart.
- State changes are published before button presses, offs before ons, so automations never see two states at once.
- Credits fall back to 95% of the runtime for movies and episodes without a marker, with or without Plex Pass.
  Music, photos and other videos never get a credits event.
