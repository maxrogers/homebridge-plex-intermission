# Releasing

## Every release

1. Move the *Unreleased* notes in `CHANGELOG.md` under a new heading, `## [x.y.z] - YYYY-MM-DD`.
2. Set `version` in `package.json` to `x.y.z`.
3. Push to `main`, then push the tag `vx.y.z`. The Release workflow tests, publishes to npm and creates the GitHub
   release with the notes from `CHANGELOG.md`.

## First release only

npm can't set up trusted publishing for a package that doesn't exist yet, so the first publish uses a short-lived
token:

1. On npmjs.com: **Access Tokens**, **Generate New Token**, **Granular Access Token**. Packages and scopes: **Read and
   write**, all packages. Turn on **Bypass two-factor authentication**. Expiry: 7 days.
2. On GitHub: repository **Settings**, **Secrets and variables**, **Actions**, **New repository secret** named
   `NPM_TOKEN` with the token.
3. Release as above. (1.0.0 is already set and `"private": true` removed.)
4. Once the package is on npm: package **Settings**, **Trusted Publisher**, **GitHub Actions**: owner `maxrogers`,
   repository `homebridge-plex-intermission`, workflow `release.yml`. The next release must happen within two days of
   saving this, or the setting has to be made again.
5. Delete the `NPM_TOKEN` secret and the token. In the package settings, choose **Require two-factor authentication and
   disallow tokens**; trusted publishing still works.

## Homebridge verification

Once the package is on npm, open a **Plugin Verification Request** at
[homebridge/plugins](https://github.com/homebridge/plugins/issues/new/choose) and attach `assets/icon-100.png` as the
icon. The requirements are on the [Verified Plugins](https://github.com/homebridge/plugins/wiki/Verified-Plugins) page.

Every requirement is met: dynamic platform, settings GUI (custom UI), runs on Node 22 and 24, doesn't start until
configured, no post-install scripts, no analytics, files only in the Homebridge storage folder, and errors are caught
and logged. For **More Information**, since homebridge-plex-metadata is already verified:

> Intermission adds to what homebridge-plex-metadata offers rather than repeating it. It credits that plugin and
> homebridge-plex-credits in its README. Beyond a playing sensor, it triggers at Plex's credits markers (re-timed on
> every skip, with mid-credits scenes), and offers pause, credits, intro and nothing-playing states with presets where
> exactly one sensor is on at a time. It follows playback through the server's push notifications as well as
> webhooks, so it works without Plex Pass and never polls. Setup is a Plex sign-in in the settings page that lists
> servers, players, people and libraries, with no tokens or IDs to copy. It also offers per-sensor filters, media
> conditions (wide, 4K, HDR, rating, labels), several servers, its own child bridge, a Guide for the Home automations,
> and a diagnostics file with private details removed.
