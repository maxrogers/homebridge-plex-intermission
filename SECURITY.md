# Security

Your Plex token gives access to your Plex account and server. Treat it like a password:

- Never paste it into issues, discussions or logs you share.
- The plugin keeps it out of Homebridge's `config.json`. It is stored in its own file in the Homebridge storage folder
  (`intermission/credentials.json`), readable only by the user Homebridge runs as.
- It never appears in the plugin's logs, its debug report or the settings page.
- Signing out in the plugin's settings deletes the stored token.
- The webhook address includes a random secret, and the plugin ignores requests to any other address.

To report a vulnerability, use GitHub's **Report a vulnerability** button on the Security tab of this repository
rather than opening a public issue.
