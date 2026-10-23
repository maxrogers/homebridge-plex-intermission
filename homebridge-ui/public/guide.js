// The Guide tab: how to make the Home automations for each preset, with screenshots of the Home app.
import { PRESETS, presetsInUse } from './model.js';

export function guideTab(sensors, collapsible) {
  const step = (html) => `<li>${html}</li>`;
  const inUse = presetsInUse(sensors);
  const head = (id, name) => `<div class="im-preset-head mt-4" data-preset="${id}"><h5 class="m-0">${name}${inUse.includes(id) ? ' <span class="im-badge on">In use</span>' : ''}</h5>
    ${inUse.includes(id) ? '' : `<button class="btn btn-sm btn-outline-secondary ms-auto" data-action="pick-preset" data-id="${id}">Add this preset</button>`}</div>`;
  /** One automation: the trigger, then either a plain light setting or a shortcut recipe. */
  const auto = (sensor, when, what, recipe) => `<div class="im-auto">
      <div class="im-auto-when"><span class="im-badge">${when === 'off' ? 'Stops detecting' : 'Detects occupancy'}</span> <strong>${sensor}</strong></div>
      <div class="im-auto-what">${what}</div>${recipe ?? ''}</div>`;
  /**
   * Shortcut steps as the Home app's shortcut editor shows them: [action, detail, indented]. `check`
   * expands to If, Stop this shortcut and End If.
   */
  const recipe = (name, steps, note) => `<div class="im-shortcut"><div class="im-shortcut-name">${name}</div><ol>
      ${steps.flatMap((x) => (Array.isArray(x[0]) ? x : [x])).map(([action, detail, indent]) => `<li><span class="im-sc-action${indent ? ' im-sc-indent' : ''}">${action}</span> ${detail}</li>`).join('')}</ol>${note ? `<p class="im-hint mt-1 mb-0">${note}</p>` : ''}</div>`;
  const set = (level) => ['Set', `your lights to <strong>${level}</strong>`];
  const wait = (seconds = 1) => ['Wait', `${seconds} second${seconds === 1 ? '' : 's'}`];
  const check = (sensor, value) => [
    ['If', `<strong>${sensor}</strong> Occupancy Detected is <strong>${value}</strong>`],
    ['Stop this shortcut', '', true],
    ['End If', ''],
  ];
  const fadeUp = (sensor) => recipe('Gentle fade up (about 3 seconds)', [set('10%'), wait(), check(sensor, 'Yes'), set('18%'), wait(), check(sensor, 'Yes'), set('25%')],
    'The checks stop the fade at once if playback comes back mid-fade, for example a mid-credits scene.');
  const crawl = recipe('Slow crawl (about 7 seconds)', [set('1%'), wait(), set('2%'), wait(), set('3%'), wait(), set('5%'), wait(),
    check('Credits Rolling', 'No'), set('15%'), wait(), set('25%')],
  'Eases eyes up from the dark before the main fade. Add more 1% steps for a longer crawl.');
  const fullHouse = recipe('Full house (about 1 second)', [set('60%'), wait(), set('100%')]);
  const pauseGlow = recipe('Pause glow (about 1 second)', [set('15%'), wait(), set('30%')]);
    const good = `<ul class="small mb-0">
      <li><strong>Why suggest sensors, not buttons?</strong> Home can always read a sensor. If it misses a change (hub restart, Wi-Fi drop, Homebridge restart), it sees the right state when it reconnects. A missed button press is simply gone. Buttons are still available for one-off actions.</li>
      <li>Pauses under 1.5 seconds, skips and quick pause-play bursts don't change any sensor, so lights never stutter. Adjust it in Settings, Advanced, <strong>Pause debounce</strong>.</li>
      <li>Movies and TV Shows get credits and intro handling. Music, Photos, Other Videos and Live TV just follow play, pause and stop.</li>
      <li>What counts as the credits is one setting shared by every sensor, so sensors that follow the credits always agree. By default a mid-credits scene counts as playing.</li>
      <li>A pause during the credits keeps "In the credits" sensors on, so a fade isn't interrupted.</li>
      <li>Stopping partway through counts after 1 second. Autoplaying the next episode isn't a stop: when playback stops in the credits or near the end, sensors wait 10 seconds for the next episode before Nothing Playing turns on. If your player's countdown is longer, raise Settings, Advanced, <strong>Stop hold</strong>.</li>
      <li>After a Homebridge restart, sensors keep their last state until Plex has been read, so lights don't jump.</li>
      <li>Renaming a sensor keeps the automations that use it. If you renamed it in the Home app, Home keeps your name. Removing a sensor removes it from Apple Home.</li>
    </ul>`;
  return `<div class="im-recipe">
    ${collapsible('good-to-know', 'Good to know', 'How Intermission behaves, in a few lines.', good, { defaultOpen: true, extraClass: 'im-callout' })}

    <h4 class="mt-4 mb-1">Making the automations</h4>
    <p class="im-muted small">Intermission makes the sensors; you make the light changes in the Home app. Each preset below lists the automations to make.</p>
    <div class="im-card"><h6>A plain automation</h6><ol>
      ${step('In the Home app, open the <strong>Automation</strong> tab, tap <strong>+</strong>, then <strong>Add Automation</strong>.')}
      ${step('Choose <strong>A Sensor Detects Something</strong>, then your Intermission sensor, for example <strong>Media Playing</strong>.')}
      ${step('Choose <strong>Detects Occupancy</strong> or <strong>Stops Detecting Occupancy</strong>, as the preset says, then <strong>Next</strong>.')}
      ${step('Pick your lights or a scene and set the level. Done.')}</ol>
      ${shots([['when', 'The sensor, Detects Occupancy, then Next', 'Step 3']])}</div>
    <div class="im-card"><h6>A fade, using a shortcut</h6>
      <p class="small im-muted mb-2">Apple Home sets lights in one jump. For a fade, the automation runs a short shortcut that steps the lights up, waiting a second between steps. Most smart dimmers already glide between levels, so 1-second steps look smooth.</p><ol>
      ${step('Make the automation as above. On the screen that lists your lights and scenes, don\'t pick anything.')}
      ${step('Scroll all the way to the bottom, past every room, and tap <strong>Convert To Shortcut</strong>.')}
      ${step('The shortcut starts with one <strong>Set</strong> step. Tap <strong>Scenes and Accessories</strong> in it, pick your lights, then tap each light to set its level.')}
      ${step('Add the rest of the recipe with the search bar at the bottom: <strong>Wait</strong>, <strong>If</strong> (pick your sensor, then <strong>Occupancy Detected</strong>), <strong>Stop this shortcut</strong> and more <strong>Set</strong> steps. Drag steps into order.')}
      ${step('Tap ✓ to save. Change the levels to suit your room; the shape matters more than the exact numbers.')}</ol>
      ${shots([
    ['convert', 'Convert To Shortcut is below the last room', 'Step 2'],
    ['shortcut-new', 'A new shortcut has one Set step', 'Step 3'],
    ['set-lights', 'Your lights in the Set step; tap one to set its level', 'Step 3'],
    ['steps', 'The end of a slow crawl: Wait, If, Stop this shortcut, End If, Set', 'Step 4'],
  ])}</div>

    ${presetSections(collapsible, {
    simple: `
    ${head('simple', 'Simple')}
    <p class="small mt-2">Best for rooms where the lights just go down while anything plays and come back for everything else, including music. Two automations:</p>
    ${auto('Media Playing', 'on', 'Set your lights dim (or a scene), in one jump.')}
    ${auto('Media Playing', 'off', 'Bring the lights back. A fade feels nicer:', fullHouse)}
`,
    credits: `
    ${head('credits', 'Simple + Credits')}
    <p class="small mt-2">Best for most living rooms and theaters. Still one sensor: it also turns off for the credits, and by default on again for a mid-credits scene. Two automations:</p>
    ${auto('Media Playing', 'on', 'Set your lights dim, in one jump, so a mid-credits scene goes dark again at once.')}
    ${auto('Media Playing', 'off', 'Fade up gently. This covers the credits, a pause and the end alike:', fadeUp('Media Playing'))}
`,
    states: `
    ${head('states', 'Every State')}
    <p class="small mt-2">Best when pause, credits and the end should each look different. Exactly one of the four sensors is on at a time, so each gets one "Detects Occupancy" automation, and none needs "Stops detecting":</p>
    ${auto('Media Playing', 'on', 'Lights down, in one jump.')}
    ${auto('Media Paused', 'on', 'A little light, for example just the lamp by the door, or:', pauseGlow)}
    ${auto('Credits Rolling', 'on', 'A slow fade up. A mid-credits scene switches back to Media Playing on its own.', crawl)}
    ${auto('Nothing Playing', 'on', 'Normal lighting.', fullHouse)}
    ${shots([['tiles', 'In the Home app, one of the four is on at a time', 'The sensors'], ['automations', 'The four automations, one per sensor', 'Finished']])}
    <div class="im-card mt-3"><h6>Ideas for Every State</h6><ul class="small mb-0">
      <li>Add a condition such as <strong>only after sunset</strong> so daytime watching leaves the lights alone.</li>
      <li>On <strong>Media Paused</strong>, light the path to the kitchen instead of the whole room.</li>
      <li>Use color: a warm scene for the credits, a dim blue for pause.</li>
      <li>Several light zones: give each its own steps in the same shortcut, for example sconces a step ahead of the overhead lights.</li>
      <li>Go beyond lights: close the shades on Media Playing, open them on Nothing Playing, or switch a fan or soundbar.</li>
      <li>One sensor per room: give each sensor its own player (Edit, Players), for example "Bedroom Playing".</li>
    </ul></div>
`,
  }, inUse)}

    <h4 class="mt-4 mb-1">Beyond the presets</h4>
    <div class="im-card"><ul class="small mb-0">
      <li><strong>Projector masking:</strong> a sensor with "Only when the media is… Wide" turns on only for wide movies. Use it with a command or an automation to switch lens memory.</li>
      <li><strong>Kids watching:</strong> a sensor limited to ratings such as G and PG, or to one Plex Home user, can keep the lights brighter.</li>
      <li><strong>Live TV:</strong> choose Live TV under a sensor's Libraries if the lights should follow it too. It never has credits.</li>
    </ul></div>
  </div>`;
}

/**
 * The Guide's presets: the ones in use first, open; the rest folded into one section. With none in
 * use, all are shown.
 */
function presetSections(collapsible, sections, inUse) {
  const ids = PRESETS.map((p) => p.id);
  const others = ids.filter((id) => !inUse.includes(id));
  if (inUse.length === 0) {
    return `<h4 class="mt-4 mb-1">Presets</h4>
    <p class="im-muted small">"Add this preset" adds its sensors to the Sensors tab.</p>
    ${ids.map((id) => sections[id]).join('')}`;
  }
  const names = (list) => list.map((id) => PRESETS.find((p) => p.id === id).name).join(', ');
  return `<h4 class="mt-4 mb-1">Your ${inUse.length === 1 ? 'preset' : 'presets'}</h4>
    <p class="im-muted small">The automations to make for the sensors you have.</p>
    ${inUse.map((id) => sections[id]).join('')}
    ${others.length ? `<div class="mt-4">${collapsible('other-presets', 'Other presets', names(others), `<p class="im-muted small mt-2 mb-0">"Add this preset" adds its sensors to the Sensors tab.</p>${others.map((id) => sections[id]).join('')}`)}</div>` : ''}`;
}

/** Guide screenshots of the Home app. Each is [file, caption, label]; tap one to see it larger. */
const GUIDE_DIR = new URL('./guide/', import.meta.url).href;
function shots(list) {
  return `<div class="im-shots">${list.map(([file, caption, label]) => `<figure class="im-shot">
      <button type="button" data-action="zoom-shot" aria-label="Show larger: ${caption}"><img src="${GUIDE_DIR}${file}.webp" alt="${caption}" loading="lazy"></button>
      <figcaption>${label ? `<strong>${label}.</strong> ` : ''}${caption}</figcaption></figure>`).join('')}</div>`;
}
