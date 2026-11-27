const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { JSDOM } = require('jsdom');
const root = join(__dirname, '../apps/frontend/build');
const dom = new JSDOM(readFileSync(join(root, 'index.html'), 'utf8'), { runScripts: 'outside-only', url: 'http://localhost/plugins/matterbridge-securitysystem-keypad/' });
const w = dom.window, d = w.document, requests = [], errors = [];
let fields = { prefix: '', entered: 0, busy: false, lockedUntil: 0, failures: 0, lastResult: null };
const state = { settings: { usbEnabled: false, devicePath: '/dev/input/alarm-keypad', exclusive: true, inputSeconds: 15, maxAttempts: 5, lockSeconds: 30 },
  credentials: [], routes: [], history: [], input: fields, usb: { enabled: false, connected: false }, controller: { label: 'Matterbridge Keypad' },
  peers: [{ id: 'bridge', label: 'Pont', connected: true, endpoints: [{ number: 21, label: 'Away', commands: [{ id: 'on', label: 'Allumer' }, { id: 'brightness', label: 'Luminosité', min: 0, max: 100 }] },
    { number: 15, label: 'Audio', commands: [{ id: 'profile', label: 'Profil', choices: [{ value: 'prealarm', label: 'Préalarme' }] }] }] }] };
w.setInterval = (callback) => { w.poll = callback; }; w.confirm = () => true;
w.fetch = async (url, options) => {
  const body = JSON.parse(options.body); requests.push({ url, body }); await new Promise((resolve) => setTimeout(resolve, 1));
  if (url.endsWith('/credential')) {
    const c = { id: body.id || 'new-credential', name: body.name, enabled: body.enabled };
    state.credentials = body.id ? state.credentials.map((old) => old.id === body.id ? c : old) : [...state.credentials, c];
  }
  if (url.endsWith('/route')) { const { session, ...route } = body; state.routes.push({ ...route, id: 'new-route' }); }
  if (url.endsWith('/clear')) { fields.prefix = ''; fields.entered = 0; }
  if (url.endsWith('/key')) {
    if (/^[+*/.\-]$/.test(body.symbol)) fields.prefix += body.symbol;
    else if (/^[0-9]$/.test(body.symbol)) fields.entered++;
    else if (body.symbol === 'Enter') { fields.entered = 0; fields.lastResult = { message: 'Commande exécutée.' }; }
    fields.route = state.routes.find((r) => r.prefix === fields.prefix)?.name;
  }
  return { ok: true, json: async () => w.JSON.parse(JSON.stringify(state)) };
};
w.addEventListener('error', (e) => errors.push(e.error));
w.eval(readFileSync(join(root, 'ui.js'), 'utf8'));
w.eval(readFileSync(join(root, 'app.js'), 'utf8'));
const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
module.exports = (async () => {
  for (let attempt = 0; attempt < 100 && d.getElementById('controls').hidden; attempt++) await tick(10);
  assert.equal(d.getElementById('key'), null); assert.equal(d.getElementById('access'), null);
  assert.ok(requests.every((r) => !Object.hasOwn(r.body, 'key')));
  assert.equal(d.getElementById('controls').hidden, false);
  const cf = d.getElementById('credential-form');
  cf.elements.name.value = 'Famille'; cf.elements.pin.value = '001234'; cf.requestSubmit(); await tick();
  assert.equal(requests.at(-1).body.pin, '001234'); assert.equal(cf.elements.pin.value, '');
  d.querySelector('#credentials button').click();
  assert.equal(cf.elements.pin.required, false); assert.equal(cf.elements.pin.value, '');
  cf.elements.name.value = 'Famille renommée'; cf.requestSubmit(); await tick();
  assert.equal(requests.at(-1).body.id, 'new-credential'); assert.equal(requests.at(-1).body.pin, '');
  const rf = d.getElementById('route-form'); rf.elements.name.value = 'Armer Away'; rf.elements.prefix.value = '+';
  const target = d.querySelector('.operation select'); target.value = 'bridge:21'; target.dispatchEvent(new w.Event('change'));
  rf.requestSubmit(); await tick();
  assert.equal(requests.at(-1).body.credentialIds, null);
  assert.equal(requests.at(-1).body.operations[0].command, 'on');
  d.querySelector('#shortcuts button').click();
  for (const symbol of '001234') d.querySelector(`[data-key="${symbol}"]`).click();
  d.getElementById('enter').click(); await tick(100);
  const keys = requests.filter((r) => r.url.endsWith('/key')).map((r) => r.body.symbol);
  assert.deepEqual(keys, ['+', '0', '0', '1', '2', '3', '4', 'Enter']);
  assert.match(d.getElementById('input-state').textContent, /exécutée/);
  const selected = d.querySelector('.operation select'); selected.value = 'bridge:15'; selected.dispatchEvent(new w.Event('change'));
  rf.elements.name.value = 'Préalarme'; rf.elements.prefix.value = '*';
  d.getElementById('all-codes').checked = false; d.getElementById('all-codes').dispatchEvent(new w.Event('change'));
  d.querySelector('#route-codes input').checked = true;
  rf.requestSubmit(); await tick();
  assert.equal(requests.at(-1).body.operations[0].value, 'prealarm');
  assert.deepEqual(requests.at(-1).body.credentialIds, ['new-credential']);
  rf.elements.name.value = 'Brouillon'; await w.poll(); assert.equal(rf.elements.name.value, 'Brouillon');
  const beforeNavigation = requests.length;
  d.getElementById('tab-settings').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  d.getElementById('tab-settings').click();
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: '1', bubbles: true }));
  await tick(); assert.equal(requests.length, beforeNavigation);
  assert.deepEqual(errors, []); assert.equal(w.localStorage.length, 0);
  assert.equal(new Set(requests.map((r) => r.body.session)).size, 1);
  console.log('Interface : codes, édition sans PIN, séquences, profils audio, saisie rapide ordonnée et brouillons validés.');
  w.close();
})().catch((error) => { w.close(); throw error; });
