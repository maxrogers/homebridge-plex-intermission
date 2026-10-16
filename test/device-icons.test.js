import assert from 'node:assert/strict';
import test from 'node:test';

import { DEVICE_ICONS, deviceIconKey } from '../homebridge-ui/public/device-icons.js';

test('picks an icon from Plex device fields', () => {
  const cases = [
    [{ product: 'Plex for Apple TV', platform: 'tvOS', title: 'Apple TV' }, 'appletv'],
    [{ product: 'Plex Media Server', platform: 'Linux' }, 'server'],
    [{ product: 'Plexamp', platform: 'iOS' }, 'music'],
    [{ product: 'Plex HTPC', platform: 'Windows' }, 'htpc'],
    [{ product: 'Plex for Android (TV)', platform: 'Android', device: 'AFTKA' }, 'stick'],
    [{ product: 'Plex for Android (TV)', platform: 'Android', device: 'SHIELD Android TV' }, 'box'],
    [{ product: 'Plex for Roku', platform: 'Roku' }, 'box'],
    [{ product: 'Plex for LG', platform: 'webOS' }, 'tv'],
    [{ product: 'Plex for Samsung', platform: 'Tizen' }, 'tv'],
    [{ product: 'Plex for Xbox', platform: 'Xbox' }, 'console'],
    [{ product: 'Plex for iOS', platform: 'iOS', device: 'iPad' }, 'tablet'],
    [{ product: 'Plex for iOS', platform: 'iOS', device: 'iPhone' }, 'phone'],
    [{ product: 'Plex for Android (Mobile)', platform: 'Android', device: 'Pixel 9' }, 'phone'],
    [{ product: 'Plex Web', platform: 'Chrome' }, 'browser'],
    [{ product: 'Plex for Mac', platform: 'macOS' }, 'laptop'],
    [{ product: 'Chromecast', platform: 'Chromecast' }, 'cast'],
    [{ product: 'Something New', platform: 'Mystery OS' }, 'default'],
    [{}, 'default'],
  ];
  for (const [device, expected] of cases) {
    assert.equal(deviceIconKey(device), expected, JSON.stringify(device));
  }
});

test('every icon is a labelled 48x48 SVG', () => {
  for (const [key, icon] of Object.entries(DEVICE_ICONS)) {
    assert.match(icon.svg, /^<svg [^>]*viewBox="0 0 48 48"/, key);
    assert.ok(icon.label, key);
  }
});
