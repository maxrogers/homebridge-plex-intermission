# Security

## How Intermission handles your Plex sign-in

Your Plex token gives access to your Plex account and servers, so Intermission treats it like a password:

- It is never written to Homebridge's `config.json`. It lives in `intermission/credentials.json` in the Homebridge
  storage folder. The folder is readable only by the user Homebridge runs as (0700), and the file likewise (0600).
- It is sent to Plex only, over HTTPS whenever the server offers it: as a request header, except for the server's
  notification connection, which Plex accepts only with the token in its address. It never appears in the log, the
  diagnostics file or the settings page.
- Signing out, or **Reset Intermission**, deletes it. Resetting also removes Intermission's webhook from your Plex
  account when Plex can be reached.
- A saved sign-in belongs to one setup. If the plugin is removed and later reinstalled, the old sign-in is deleted
  rather than reused.

Plex webhooks arrive at an address that ends in a random 128-bit key made for your Homebridge. Requests to any
other address are ignored, so other devices on your network can't trigger your sensors.

Intermission contains no analytics and contacts nothing but plex.tv and your Plex servers.

## Commands

The optional Commands feature runs shell commands you write, with Homebridge's permissions. It is off until you turn
it on. Values such as titles are quoted before they reach the shell, so a title can't change what a command does.

## Reporting a vulnerability

Please use GitHub's **Report a vulnerability** button on this repository's Security tab rather than a public issue.
Never post your Plex token anywhere.
