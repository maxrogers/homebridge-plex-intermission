# Contributing

Thanks for helping. Bug reports, feature ideas and pull requests are all welcome.

## Reporting

- **Bugs**: use the [bug report form](../../issues/new?template=bug_report.yml). Include the plugin version, your
  Homebridge setup and a debug report (Diagnostics tab, with Detailed logging turned on).
- **Never post your Plex token**, and check logs and config snippets before pasting them.

## Development

```bash
git clone https://github.com/maxrogers/homebridge-plex-intermission.git
cd homebridge-plex-intermission
npm install
npm run lint       # ESLint, no warnings allowed
npm test           # builds, then runs the test suite
```

To try a local build in Homebridge: `npm install /path/to/homebridge-plex-intermission` from the Homebridge storage
directory, then restart Homebridge.

`tools/intermission-probe.mjs` measures how your Plex server and players report playback (positions, webhooks,
server notifications, credits markers). Run it with `PLEX_TOKEN` set; see the header of the file.

### Layout

| Path | What |
|---|---|
| `src/engine/` | Playback engine: turns Plex notifications and webhooks into play, pause, resume, stop, seek and credits events |
| `src/plex/` | Plex server requests, the notification websocket, the webhook server and payload parsing |
| `src/platform.ts` | Homebridge platform |
| `homebridge-ui/` | The settings page |
| `test/` | Unit tests, replays of recorded playback (`test/fixtures/`) and a Homebridge start and stop check |
| `tools/` | Developer tools such as the Plex timing probe |
| `assets/` | The icon source (`icon.svg`); `icon.png` is made from it |

See [ARCHITECTURE.md](ARCHITECTURE.md).

### Pull requests

- Keep changes focused, add or update tests, and run `npm test`.
- Update `CHANGELOG.md` under *Unreleased*.
