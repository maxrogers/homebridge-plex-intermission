<p align="center"><img src="icon.png" width="128" alt="Intermission for Plex"></p>

<h1 align="center">homebridge-plex-intermission</h1>

<p align="center">Turn Plex playback, pauses and credits into HomeKit sensors. Lights down when the movie starts, up when the credits roll.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/homebridge-plex-intermission"><img src="https://img.shields.io/npm/v/homebridge-plex-intermission" alt="npm"></a>
  <a href="https://github.com/maxrogers/homebridge-plex-intermission/actions"><img src="https://github.com/maxrogers/homebridge-plex-intermission/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

> Not affiliated with or endorsed by Plex, Inc. "Plex" is used only to describe compatibility.

> **Status: in development, ready for early testing.** Not yet on npm. The design lives in [ARCHITECTURE.md](ARCHITECTURE.md).

## Why this exists

I build things I need for myself, and sometimes I share them. This is one of those: I wanted my lights to dim when a
movie starts and come back up when the credits roll, using nothing but Apple Home.

## How it differs from other Plex plugins

Other Plex plugins give you one "playing" sensor, set up by pasting a token and player ID, and updated by polling or by
webhooks alone. Intermission:

- **Triggers at the credits marker**, re-timed whenever you skip, not just on playing and stopped
- **Uses Plex's push notifications plus webhooks:** no polling, and it still works, with fewer events, without Plex Pass
- **Gives pause, credits and stop their own triggers**, so each can run a different scene
- **Signs in with Plex** and lists your players, users and libraries; no tokens or IDs to copy

## Features (planned)

- **Credits-aware:** a trigger at the moment the credits start, using Plex's own credits markers, never before
- **Instant, no polling:** driven by your Plex server's push notifications and webhooks; skips and seeks are picked up the moment they happen
- **Every Plex event:** play, pause, resume, stop, scrobble, rate, new library items, On Deck and server-owner events, plus derived events such as credits start and intro start
- **Sensors you design:** HomeKit occupancy, motion or contact sensors for states, and buttons for one-off events, filtered by player, user, library and media type
- **Sign in with Plex:** players, users and libraries are listed for you to pick; no token hunting
- **A suggested Movie Night setup** in one tap, or build your own on a drag-and-drop board
- **One-click webhook setup:** shows your current Plex webhooks and asks before changing anything
- **Home recipes:** step-by-step Home app automations, including gentle fades that differ for credits and pause
- **Live view and debug report** for troubleshooting

## Requirements

- Homebridge 2.x (v1 is not supported)
- Node.js 22.10 or later, 24 or 26
- Plex Media Server
- Plex Pass on the server owner's account is recommended. Without it, Intermission still works: playback start is
  detected up to 10 seconds later, credits use markers already on your server or a percentage of the runtime, and a few
  events (ratings, new library items) are unavailable. If you add Plex Pass later, Intermission notices and offers the extras.

## How it works

Your Plex server pushes playback updates to the plugin the moment they happen: play, pause, resume, stop, and every
skip or seek. When something starts playing, the plugin reads where the credits begin and sets a timer for that exact
moment, re-setting it whenever you skip around. Your Home automations react to the sensors. The plugin never controls
your lights itself. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Support and contributing

- Found a bug? [Report it](https://github.com/maxrogers/homebridge-plex-intermission/issues/new?template=bug_report.yml). Please never post your Plex token.
- Have an idea? [Suggest a feature](https://github.com/maxrogers/homebridge-plex-intermission/issues/new?template=feature_request.yml).
- Pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
- If this plugin makes movie night better, you can [buy me a coffee](https://ko-fi.com/maxrogers).

## Acknowledgements

- [homebridge-plex-credits](https://github.com/DavidD303/homebridge-plex-metadata/tree/credits-aware-playback) by DavidD303: the credits-marker approach this plugin builds on
- [homebridge-plex-metadata](https://github.com/davidmuzi/homebridge-plex-metadata) by davidmuzi, which homebridge-plex-credits is based on

## License

[MIT](LICENSE)
