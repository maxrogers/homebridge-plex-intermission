// Icons for Plex players and servers in the settings page. 48x48, stroked in currentColor so they follow
// the Homebridge theme, with accents from --im-accent. Generic device shapes only, no brand logos.

const S = 'fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"';
const BODY = 'fill="currentColor" fill-opacity="0.08"';
const ACC = 'fill="var(--im-accent, #f5a524)"';
const ACC_SOFT = 'fill="var(--im-accent, #f5a524)" fill-opacity="0.28"';
const GLINT = 'stroke="#ffffff" stroke-opacity="0.7" stroke-width="2" stroke-linecap="round" fill="none"';

const wrap = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true">${body}</svg>`;
const play = (cx, cy, r) => `<path d="M${cx - r * 0.45} ${cy - r * 0.7} L${cx + r * 0.75} ${cy} L${cx - r * 0.45} ${cy + r * 0.7} Z" ${ACC} stroke="var(--im-accent, #f5a524)" stroke-width="1.5" stroke-linejoin="round"/>`;

export const DEVICE_ICONS = {
  appletv: {
    label: 'Streaming box with remote',
    svg: wrap(`
      <rect x="5" y="21" width="28" height="13" rx="4.5" ${BODY}/><rect x="5" y="21" width="28" height="13" rx="4.5" ${S}/>
      <circle cx="27.5" cy="27.5" r="1.8" ${ACC}/>
      <path d="M9 38h20" ${S} stroke-opacity="0.35"/>
      <rect x="36.5" y="12" width="7" height="25" rx="3.5" ${BODY}/><rect x="36.5" y="12" width="7" height="25" rx="3.5" ${S}/>
      <circle cx="40" cy="18" r="2" ${ACC}/>`),
  },
  box: {
    label: 'Streaming box',
    svg: wrap(`
      <rect x="8" y="15" width="32" height="19" rx="6" ${BODY}/><rect x="8" y="15" width="32" height="19" rx="6" ${S}/>
      <path d="M13 20h6" ${GLINT}/>
      <circle cx="34" cy="28" r="2" ${ACC}/>
      <path d="M13 38h4M31 38h4" ${S}/>`),
  },
  stick: {
    label: 'Streaming stick',
    svg: wrap(`
      <rect x="6" y="18" width="28" height="12" rx="6" ${BODY}/><rect x="6" y="18" width="28" height="12" rx="6" ${S}/>
      <rect x="34" y="20.5" width="8" height="7" rx="1.5" ${S}/>
      <circle cx="12.5" cy="24" r="2" ${ACC}/>
      <path d="M18 24h10" ${S} stroke-opacity="0.35"/>`),
  },
  tv: {
    label: 'Smart TV',
    svg: wrap(`
      <rect x="5" y="8" width="38" height="25" rx="5" ${BODY}/>
      <rect x="9" y="12" width="30" height="17" rx="2.5" ${ACC_SOFT}/>
      <rect x="5" y="8" width="38" height="25" rx="5" ${S}/>
      ${play(24, 20.5, 5)}
      <path d="M24 33v5M17 39.5h14" ${S}/>`),
  },
  phone: {
    label: 'Phone',
    svg: wrap(`
      <rect x="14" y="5" width="20" height="38" rx="6" ${BODY}/>
      <rect x="17.5" y="11" width="13" height="24" rx="2" ${ACC_SOFT}/>
      <rect x="14" y="5" width="20" height="38" rx="6" ${S}/>
      <path d="M21.5 8.2h5" ${S}/>
      ${play(24, 23, 4)}`),
  },
  tablet: {
    label: 'Tablet',
    svg: wrap(`
      <rect x="8" y="6" width="32" height="36" rx="6" ${BODY}/>
      <rect x="12" y="10" width="24" height="26" rx="2.5" ${ACC_SOFT}/>
      <rect x="8" y="6" width="32" height="36" rx="6" ${S}/>
      <circle cx="24" cy="39" r="1.2" fill="currentColor"/>
      ${play(24, 23, 5)}`),
  },
  laptop: {
    label: 'Computer',
    svg: wrap(`
      <rect x="10" y="10" width="28" height="20" rx="3.5" ${BODY}/>
      <rect x="13.5" y="13.5" width="21" height="13" rx="1.5" ${ACC_SOFT}/>
      <rect x="10" y="10" width="28" height="20" rx="3.5" ${S}/>
      <path d="M5 34h38l-2.5 4.5h-33z" ${BODY}/><path d="M5 34h38l-2.5 4.5h-33z" ${S}/>
      ${play(24, 20, 4)}`),
  },
  browser: {
    label: 'Web browser',
    svg: wrap(`
      <rect x="5" y="8" width="38" height="31" rx="6" ${BODY}/><rect x="5" y="8" width="38" height="31" rx="6" ${S}/>
      <path d="M5 16h38" ${S}/>
      <circle cx="10.5" cy="12" r="1.5" ${ACC}/><circle cx="15.5" cy="12" r="1.5" fill="currentColor" fill-opacity="0.45"/><circle cx="20.5" cy="12" r="1.5" fill="currentColor" fill-opacity="0.25"/>
      ${play(24, 27.5, 5.5)}`),
  },
  htpc: {
    label: 'Desktop',
    svg: wrap(`
      <rect x="6" y="7" width="36" height="25" rx="4.5" ${BODY}/>
      <rect x="10" y="11" width="28" height="17" rx="2" ${ACC_SOFT}/>
      <rect x="6" y="7" width="36" height="25" rx="4.5" ${S}/>
      <path d="M20 32l-1.5 7h11L28 32M16 39.5h16" ${S}/>
      ${play(24, 19.5, 5)}`),
  },
  console: {
    label: 'Game console',
    svg: wrap(`
      <path d="M15 15h18c6 0 9.5 5 10.5 11.5l1 6.5c.6 3.8-3.6 6-6.3 3.3L33.5 32h-19l-4.7 4.3c-2.7 2.7-6.9.5-6.3-3.3l1-6.5C5.5 20 9 15 15 15z" ${BODY}/>
      <path d="M15 15h18c6 0 9.5 5 10.5 11.5l1 6.5c.6 3.8-3.6 6-6.3 3.3L33.5 32h-19l-4.7 4.3c-2.7 2.7-6.9.5-6.3-3.3l1-6.5C5.5 20 9 15 15 15z" ${S}/>
      <path d="M15.5 20.5v7M12 24h7" ${S}/>
      <circle cx="31.5" cy="21.5" r="2" ${ACC}/><circle cx="35.5" cy="25.5" r="2" ${ACC}/>`),
  },
  music: {
    label: 'Music player',
    svg: wrap(`
      <path d="M9 30v-5a15 15 0 0 1 30 0v5" ${S}/>
      <rect x="6" y="27" width="9" height="14" rx="4" ${ACC}/><rect x="6" y="27" width="9" height="14" rx="4" ${S}/>
      <rect x="33" y="27" width="9" height="14" rx="4" ${ACC}/><rect x="33" y="27" width="9" height="14" rx="4" ${S}/>`),
  },
  speaker: {
    label: 'Speaker',
    svg: wrap(`
      <rect x="13" y="5" width="22" height="38" rx="9" ${BODY}/><rect x="13" y="5" width="22" height="38" rx="9" ${S}/>
      <circle cx="24" cy="29" r="7.5" ${ACC_SOFT}/><circle cx="24" cy="29" r="7.5" ${S}/>
      <circle cx="24" cy="29" r="2.4" ${ACC}/>
      <circle cx="24" cy="14" r="2.4" ${S}/>`),
  },
  cast: {
    label: 'Cast device',
    svg: wrap(`
      <path d="M6 15v-4a4 4 0 0 1 4-4h28a4 4 0 0 1 4 4v26a4 4 0 0 1-4 4H26" ${S}/>
      <path d="M6 33a8 8 0 0 1 8 8" ${S} stroke="var(--im-accent, #f5a524)"/>
      <path d="M6 25a16 16 0 0 1 16 16" ${S} stroke="var(--im-accent, #f5a524)"/>
      <circle cx="7" cy="40" r="2" ${ACC}/>`),
  },
  vr: {
    label: 'VR headset',
    svg: wrap(`
      <path d="M12 15h24a8 8 0 0 1 8 8v4a8 8 0 0 1-8 8h-6l-3-4h-6l-3 4h-6a8 8 0 0 1-8-8v-4a8 8 0 0 1 8-8z" ${BODY}/>
      <path d="M12 15h24a8 8 0 0 1 8 8v4a8 8 0 0 1-8 8h-6l-3-4h-6l-3 4h-6a8 8 0 0 1-8-8v-4a8 8 0 0 1 8-8z" ${S}/>
      <circle cx="15.5" cy="25" r="4" ${ACC}/><circle cx="32.5" cy="25" r="4" ${ACC}/>`),
  },
  car: {
    label: 'Car',
    svg: wrap(`
      <path d="M11 24l3.4-7.6c.7-1.6 2.2-2.6 3.9-2.6h11.4c1.7 0 3.2 1 3.9 2.6L37 24z" ${ACC_SOFT}/>
      <path d="M11 24l3.4-7.6c.7-1.6 2.2-2.6 3.9-2.6h11.4c1.7 0 3.2 1 3.9 2.6L37 24" ${S}/>
      <path d="M24 14v10" ${S} stroke-opacity="0.35"/>
      <rect x="6" y="24" width="36" height="11" rx="4.5" ${BODY}/><rect x="6" y="24" width="36" height="11" rx="4.5" ${S}/>
      <circle cx="11.5" cy="29.5" r="1.9" ${ACC}/><circle cx="36.5" cy="29.5" r="1.9" ${ACC}/>
      <circle cx="15" cy="37" r="3.2" fill="currentColor"/><circle cx="33" cy="37" r="3.2" fill="currentColor"/>`),
  },
  server: {
    label: 'Plex Media Server',
    svg: wrap(`
      <rect x="9" y="6" width="30" height="10.5" rx="3.5" ${BODY}/><rect x="9" y="6" width="30" height="10.5" rx="3.5" ${S}/>
      <rect x="9" y="18.75" width="30" height="10.5" rx="3.5" ${BODY}/><rect x="9" y="18.75" width="30" height="10.5" rx="3.5" ${S}/>
      <rect x="9" y="31.5" width="30" height="10.5" rx="3.5" ${BODY}/><rect x="9" y="31.5" width="30" height="10.5" rx="3.5" ${S}/>
      <circle cx="14.5" cy="11.25" r="1.8" ${ACC}/><circle cx="14.5" cy="24" r="1.8" ${ACC}/><circle cx="14.5" cy="36.75" r="1.8" ${ACC}/>
      <path d="M22 11.25h11M22 24h11M22 36.75h11" ${S} stroke-opacity="0.35"/>`),
  },
  default: {
    label: 'Player',
    svg: wrap(`
      <circle cx="24" cy="24" r="17" ${BODY}/><circle cx="24" cy="24" r="17" ${S}/>
      <circle cx="24" cy="24" r="11" ${ACC_SOFT}/>
      ${play(25, 24, 8)}
      <path d="M14 15.5a12.5 12.5 0 0 1 5-3.5" ${GLINT}/>`),
  },
};

/**
 * Picks an icon key for a Plex device from the fields Plex reports
 * (product, platform, device or model, name). Order matters: the most specific rules come first.
 */
export function deviceIconKey(d = {}) {
  const product = `${d.product ?? ''}`;
  const platform = `${d.platform ?? ''}`;
  const model = `${d.device ?? ''} ${d.model ?? ''}`;
  const all = `${product} ${platform} ${model} ${d.name ?? ''} ${d.title ?? ''}`;
  const has = (re, s = all) => re.test(s);

  if (has(/plex media server/i, product) || has(/\bserver\b/i, `${d.provides ?? ''}`)) return 'server';
  if (has(/plexamp/i)) return 'music';
  if (has(/htpc/i)) return 'htpc';
  if (has(/tvos/i, platform) || has(/apple ?tv/i)) return 'appletv';
  if (has(/android auto|carplay/i)) return 'car';
  if (has(/quest|oculus|vision ?pro|visionos/i)) return 'vr';
  if (has(/xbox|playstation|\bps[345]\b/i)) return 'console';
  if (has(/sonos|alexa|echo/i)) return 'speaker';
  if (has(/chromecast|google cast/i) && !has(/google tv streamer/i)) return 'cast';
  if (has(/\bAFT[A-Z0-9]*\b/, model) || has(/fire ?tv ?stick|streaming stick/i)) return 'stick';
  if (has(/shield|roku|fire ?tv|google tv streamer|\bonn\b|mi box/i)) return 'box';
  if (has(/webos|tizen|vizio|smartcast|vidaa|netcast|bravia|for lg|for samsung|for vizio|for hisense|android \(tv\)|android tv/i)) return 'tv';
  if (has(/ipad|tablet/i)) return 'tablet';
  if (has(/ios|iphone/i) || has(/android/i)) return 'phone';
  if (has(/plex web|chrome|safari|firefox|edge|opera/i)) return 'browser';
  if (has(/windows|mac ?os|macos|linux|for mac|for windows|desktop/i)) return 'laptop';
  return 'default';
}

/** Returns the SVG markup for a Plex device. */
export function deviceIcon(d) {
  return DEVICE_ICONS[deviceIconKey(d)].svg;
}

/** People, in the same style. */
export const PEOPLE_ICONS = {
  everyone: wrap(`
    <circle cx="15" cy="17" r="5" ${BODY}/><circle cx="15" cy="17" r="5" ${S} stroke-opacity="0.55"/>
    <path d="M5.5 37c0-5.5 4.2-9.5 9.5-9.5 2.2 0 4.1.6 5.6 1.8" ${S} stroke-opacity="0.55"/>
    <circle cx="33" cy="17" r="5" ${BODY}/><circle cx="33" cy="17" r="5" ${S} stroke-opacity="0.55"/>
    <path d="M42.5 37c0-5.5-4.2-9.5-9.5-9.5-2.2 0-4.1.6-5.6 1.8" ${S} stroke-opacity="0.55"/>
    <circle cx="24" cy="20" r="6.5" ${ACC_SOFT}/><circle cx="24" cy="20" r="6.5" ${S}/>
    <path d="M12.5 41c0-6.5 5-11.5 11.5-11.5S35.5 34.5 35.5 41" ${BODY}/><path d="M12.5 41c0-6.5 5-11.5 11.5-11.5S35.5 34.5 35.5 41" ${S}/>`),
  person: wrap(`
    <circle cx="24" cy="17" r="7.5" ${ACC_SOFT}/><circle cx="24" cy="17" r="7.5" ${S}/>
    <path d="M10 41c0-7.7 6.3-13.5 14-13.5S38 33.3 38 41" ${BODY}/><path d="M10 41c0-7.7 6.3-13.5 14-13.5S38 33.3 38 41" ${S}/>`),
};

/** Library kinds from discovery: movie, show, music, photo, other. */
export const LIBRARY_ICONS = {
  movie: wrap(`
    <rect x="7" y="16" width="34" height="23" rx="4" ${BODY}/><rect x="7" y="16" width="34" height="23" rx="4" ${S}/>
    <path d="M7 16l6-8 6 8M19 16l6-8 6 8M31 16l6-8 4 5" ${S}/>
    ${play(24, 27.5, 7)}`),
  show: wrap(`
    <rect x="6" y="11" width="36" height="24" rx="4" ${BODY}/><rect x="6" y="11" width="36" height="24" rx="4" ${S}/>
    <path d="M18 41h12M24 35v6" ${S}/>
    <rect x="12" y="17" width="10" height="12" rx="2" ${ACC_SOFT}/><rect x="26" y="17" width="10" height="12" rx="2" ${ACC_SOFT}/>
    <path d="M13 15h0" ${GLINT}/>`),
  music: wrap(`
    <path d="M19 33V12l20-4v21" ${S}/>
    <ellipse cx="14" cy="34" rx="5.5" ry="4.5" ${ACC}/><ellipse cx="14" cy="34" rx="5.5" ry="4.5" ${S}/>
    <ellipse cx="34" cy="30" rx="5.5" ry="4.5" ${ACC}/><ellipse cx="34" cy="30" rx="5.5" ry="4.5" ${S}/>
    <path d="M19 17l20-4" ${S} stroke-opacity="0.45"/>`),
  photo: wrap(`
    <rect x="6" y="10" width="36" height="28" rx="5" ${BODY}/><rect x="6" y="10" width="36" height="28" rx="5" ${S}/>
    <circle cx="16" cy="19" r="3.5" ${ACC}/>
    <path d="M6 33l11-10 8 7 5-4 12 9" ${S}/>`),
  other: wrap(`
    <rect x="6" y="13" width="26" height="22" rx="5" ${BODY}/><rect x="6" y="13" width="26" height="22" rx="5" ${S}/>
    <path d="M32 21l10-5v16l-10-5" ${S}/>
    <circle cx="13" cy="20" r="2" ${ACC}/>`),
  livetv: wrap(`
    <rect x="6" y="16" width="36" height="24" rx="4" ${BODY}/><rect x="6" y="16" width="36" height="24" rx="4" ${S}/>
    <path d="M17 7l7 9 7-9" ${S}/>
    <circle cx="34" cy="22" r="2.5" ${ACC}/>
    <path d="M12 30c3-4 7-4 10 0" ${S} stroke-opacity="0.45"/>`),
};

/** HomeKit sensor types, for the sensor board. */
export const SENSOR_ICONS = {
  occupancy: wrap(`
    <path d="M8 22L24 9l16 13v17a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3z" ${BODY}/><path d="M8 22L24 9l16 13v17a3 3 0 0 1-3 3H11a3 3 0 0 1-3-3z" ${S}/>
    <circle cx="24" cy="24" r="3.5" ${ACC}/><path d="M18 37c0-3.6 2.7-6 6-6s6 2.4 6 6" ${S}/>`),
  motion: wrap(`
    <circle cx="27" cy="9.5" r="3.5" ${ACC}/>
    <path d="M24 16l-5 9 6 4-3 11M19 25l-7 2M25 29l7 3M24 16l7 5 5-2" ${S}/>
    <path d="M6 16h6M4 23h6" ${S} stroke-opacity="0.45"/>`),
  contact: wrap(`
    <rect x="8" y="10" width="13" height="28" rx="3" ${BODY}/><rect x="8" y="10" width="13" height="28" rx="3" ${S}/>
    <rect x="27" y="10" width="13" height="28" rx="3" ${ACC_SOFT}/><rect x="27" y="10" width="13" height="28" rx="3" ${S}/>
    <path d="M23 20v8M25 20v8" ${S} stroke-opacity="0.45"/>`),
  button: wrap(`
    <circle cx="24" cy="24" r="16" ${BODY}/><circle cx="24" cy="24" r="16" ${S}/>
    <circle cx="24" cy="24" r="8" ${ACC}/>
    <path d="M17 14.5a11 11 0 0 1 5-2.3" ${GLINT}/>`),
};
