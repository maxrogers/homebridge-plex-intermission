# Reliability lab

Compares Home automations built on buttons with ones built on sensors, end to end:

- **Homebridge 2** runs the plugin from this repository (build it first with `npm run build` in the repo root).
- **A simulated Plex Media Server** (`plex-mock.mjs`) sends websocket notifications and webhooks with Plex's real
  timing: progress every 10 s, immediate pause/resume/seek/stop, and a late first report after play.
- **A real HAP controller** (`hub.mjs`, using `hap-controller`) pairs with the bridge and subscribes to events, like an
  Apple home hub. It can go offline and come back, and it reads sensor values on reconnect.
- **Virtual lights** run modelled Home automations: set a level, or a stepped fade shortcut that can check a sensor
  and stop.

Rigs: A buttons only, B sensors only, B2 sensors only with a hub that ignores changes it first sees on reconnect,
C one sensor plus three buttons.

```sh
cd tools/reliability-lab
npm install --ignore-scripts   # skips hap-controller's optional Bluetooth build
node lab.mjs run               # scripted scenarios, about 4 minutes
SEED=7 ROUNDS=40 node fuzz.mjs fuzz   # randomised actions and hub outages, about 11 minutes
```

Results go to `results-<label>.json` and `homebridge-<label>.log`. What it cannot test: Apple's own hub software. The
automation behaviour is a model; B and B2 bracket the one thing that is uncertain (whether a hub runs a sensor
automation for a change it first sees when reconnecting).
