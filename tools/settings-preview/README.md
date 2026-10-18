# Settings page preview

The settings page (`homebridge-ui/public`) running in a browser against a mocked Homebridge and Plex, for checking
setup flows and appearance without a Homebridge install.

```sh
cd tools/settings-preview
npm install
node serve.mjs &            # http://localhost:8765/?s=<scenario>
node flows.mjs              # clicks through every setup path and checks the saved config
mkdir -p shots && node shoot.mjs shots   # light and dark screenshots of each screen
```

Scenarios include `signin`, `server`, `choose`, `main`, `edit`, `advanced`, `ended`, `commands` and `recipes`.
`?servers=srv,cab,mom` sets which Plex servers the account has, and `?existing=<config JSON>` starts from a saved setup.
Set `CHROMIUM` to a browser binary if Playwright's own is not installed.
