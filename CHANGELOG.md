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
- Setup wizard with the Movie Night suggestion, a sensor board, Recipes & Notes, and Advanced settings with reset.
- Works without Plex Pass: credits fall back to 95% of the runtime when an item has no marker, and webhooks are skipped.
