# Contributing

Bug reports, ideas and pull requests are welcome.

## Reporting

- **Bugs:** use the [bug report form](../../issues/new?template=bug_report.yml) and attach the diagnostics file
  (plugin settings, Settings, Diagnostics). It leaves out your Plex sign-in, and titles and names unless you include them.
- **Never post your Plex token**, and check anything you paste.

## Development

Needs Node.js 22.10 or later.

```bash
git clone https://github.com/maxrogers/homebridge-plex-intermission.git
cd homebridge-plex-intermission
npm install
npm run lint       # ESLint, no warnings allowed
npm test           # builds, then runs the tests
```

To try a build in Homebridge, run `npm pack`, then install the `.tgz` from the Homebridge storage folder with
`npm install /path/to/homebridge-plex-intermission-<version>.tgz` and restart Homebridge.

### Tools

| Tool | What it does |
|---|---|
| `tools/settings-preview` | The settings page against a mocked Homebridge and Plex: `node serve.mjs`, then `node flows.mjs` clicks through every setup path and setting, and `node shoot.mjs shots` takes light and dark screenshots. |
| `tools/reliability-lab` | A real Homebridge, a simulated Plex server and a HAP controller standing in for a home hub. Compares sensors with buttons through hub outages, restarts and skips. |
| `tools/intermission-probe.mjs` | Measures how your own Plex server and players report playback. Run it with `PLEX_TOKEN` set; see the top of the file. |

### Layout

| Path | What |
|---|---|
| `src/engine/` | Playback engine: Plex notifications and webhooks in; play, pause, resume, stop, seek, credits and intro events out |
| `src/plex/` | Plex server and plex.tv requests, the notification websocket, the webhook receiver and payload parsing |
| `src/sensors/` | Sensor filters and conditions, the HomeKit accessories, and the hub that combines several servers |
| `src/controller.ts` | Connects one Plex server, the engine and the sensors |
| `src/platform.ts` | The Homebridge platform: accessories, start-up and shutdown |
| `src/config.ts`, `src/storage.ts` | Config parsing with ranges; the sign-in and plugin state on disk |
| `src/setup-service.ts`, `src/report.ts` | What the settings page asks of Plex, and the diagnostics file |
| `homebridge-ui/` | The settings page: `server.js` answers its requests; `public/app.js` is the page, `public/guide.js` the Guide tab, `public/model.js` the testable helpers |
| `test/` | Unit tests and replays of recorded playback (`test/fixtures/`) |
| `assets/` | Icon sources; `icon.png` is made from `icon.svg` |

[ARCHITECTURE.md](ARCHITECTURE.md) explains the design and the measurements behind it.

Releases are made from tags; see [docs/releasing.md](docs/releasing.md).

### Pull requests

- Keep changes focused, add or update tests, and run `npm run lint` and `npm test`.
- Note the change in `CHANGELOG.md` under *Unreleased*.
