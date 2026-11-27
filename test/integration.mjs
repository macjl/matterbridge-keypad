import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ControllerBehavior, Endpoint, Environment, Logger, LogLevel, ServerNode } from 'matterbridge/matter';
import { OnOffClient } from 'matterbridge/matter/behaviors';
import { OnOffLightDevice } from 'matterbridge/matter/devices';
import { createRequire } from 'node:module';

const nodes = [];
const base = 'http://127.0.0.1:46104/plugins/';
const plugins = { keypad: 'matterbridge-securitysystem-keypad', alarm: 'matterbridge-securitysystem-core' };
const session = 'keypad-integration-session';
Logger.level = LogLevel.ERROR;
async function api(plugin, action = 'status', fields = {}) {
  const send = () => fetch(base + plugins[plugin] + '/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, ...fields }), signal: AbortSignal.timeout(40000) });
  let response = await send();
  if (response.status === 401) {
    const login = await fetch(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: '' }) });
    assert.equal((await login.json()).valid, true); response = await send();
  }
  return response.json();
}
async function ok(plugin, action, fields) { const data = await api(plugin, action, fields); assert.ifError(data.error); return data; }
async function until(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout; let cause;
  do { try { const result = await fn(); if (result) return result; } catch (error) { cause = error; } await delay(100); } while (Date.now() < deadline);
  throw new Error('Timeout : ' + label, { cause });
}
async function type(value, source = session) {
  let data; for (const symbol of value) data = await ok('keypad', 'key', { symbol, session: source });
  return ok('keypad', 'key', { symbol: 'Enter', session: source });
}
try {
  for (const plugin of ['matterbridge-securitysystem-core', 'matterbridge-securitysystem-audio', 'matterbridge-securitysystem-keypad']) {
    await until(async () => (await fetch(base + plugin + '/api/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 401, 'anonymous API blocked');
  }
  console.log('Les trois API refusent les requêtes anonymes avant la connexion Matterbridge.');
  await until(async () => (await api('keypad')).settings && (await api('alarm')).alarm, 'startup');

  assert.equal((await ok('keypad')).credentials.length, 0);
  const native = createRequire(import.meta.url)('/usr/local/lib/node_modules/matterbridge-securitysystem-keypad/native/evdev.node');
  assert.throws(() => native.name(-1)); assert.throws(() => native.grab(-1, true));
  Environment.default.vars.set('path.root', mkdtempSync('/tmp/keypad-home-'));
  const home = await ServerNode.create(ServerNode.RootEndpointWithoutGroupcast.with(ControllerBehavior), {
    id: 'keypad-test-home', commissioning: { enabled: false }, network: { port: 0 }, controller: { adminFabricLabel: 'Maison test' },
  }); nodes.push(home); await home.start();
  const ip = Object.values(networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal).address;
  async function pair(port, code) {
    const peer = await home.peers.forDescriptor({ addresses: [{ type: 'udp', ip, port }] });
    await peer.commission({ pairingCode: code, autoSubscribe: true }); return peer;
  }
  const bridge = await pair(46103, readFileSync('/test/bridge-code', 'utf8').trim());
  await ok('keypad', 'pair-device', { code: (await bridge.openEnhancedCommissioningWindow()).manualPairingCode });
  const self = await until(async () => (await ok('keypad')).peers.find((p) => p.connected && p.endpoints.some((e) => e.label === 'Alarme · Désarmer')), 'keypad subscribed to bridge');
  const physical = await ServerNode.create({ id: 'keypad-test-light', network: { port: 46101 }, commissioning: { passcode: 20202021, discriminator: 1731 } });
  nodes.push(physical); await physical.add(new Endpoint(OnOffLightDevice, { id: 'light', number: 1, onOff: { onOff: false } })); await physical.start();
  const lamp = await pair(46101, physical.state.commissioning.pairingCodes.manualPairingCode);
  await ok('alarm', 'pair-device', { code: (await lamp.openEnhancedCommissioningWindow()).manualPairingCode });
  await ok('keypad', 'pair-device', { code: (await lamp.openEnhancedCommissioningWindow()).manualPairingCode });
  const sensor = await until(async () => (await ok('alarm')).peers.find((p) => p.connected), 'alarm subscription');
  const controlled = await until(async () => (await ok('keypad')).peers.find((p) => p.connected && p.id !== self.id), 'generic lamp subscription');
  const zone = (await ok('alarm', 'zone', { name: 'RDC' })).alarm.zones.at(-1);
  await ok('alarm', 'rule', { name: 'Lumière détectée', zoneIds: [zone.id], peer: sensor.id, endpoint: 1, signal: 'power', trigger: 'active' });
  const mode = (await ok('alarm', 'mode', { name: 'Away', zones: [zone.id], activationSeconds: 0, triggerSeconds: 1, alarmSeconds: 0, actions: {} })).alarm.modes.at(-1);
  let alarm = await ok('alarm');
  const modeEndpoint = alarm.accessories.modes.switches.find((s) => s.modeId === mode.id).endpoint;
  const disarmEndpoint = alarm.accessories.modes.endpoint;
  await until(async () => (await ok('keypad')).peers.find((p) => p.id === self.id)?.endpoints.some((e) => e.number === modeEndpoint), 'new mode advertised');
  await ok('keypad', 'credential', { name: 'Famille', pin: '004281', enabled: true });
  const family = (await ok('keypad')).credentials[0];
  await ok('keypad', 'credential', { name: 'Invité', pin: '778899', enabled: true });
  const route = (name, prefix, peer, endpoint, command, credentialIds = null) => ok('keypad', 'route', { name, prefix, enabled: true, credentialIds, operations: [{ peer, endpoint, command }] });
  await route('Armer Away', '+', self.id, modeEndpoint, 'on');
  await route('Désarmer', '-', self.id, disarmEndpoint, 'on', [family.id]);
  await route('Lampe allumée', '*', controlled.id, 1, 'on');
  await route('Lampe éteinte', '/', controlled.id, 1, 'off');
  const publicStatus = await ok('keypad');
  assert.ok(!JSON.stringify(publicStatus).includes('004281')); assert.ok(!JSON.stringify(publicStatus).includes('scrypt-v1'));
  assert.equal((await type('+111111')).result.outcome, 'denied'); assert.equal((await ok('alarm')).alarm.state.phase, 'disarmed');
  for (const symbol of '+004281') await ok('keypad', 'key', { symbol });
  assert.equal((await ok('keypad', 'key', { symbol: 'Enter', session: 'another-isolated-session' })).result.outcome, 'invalid');
  assert.equal((await ok('keypad', 'key', { symbol: 'Enter' })).result.outcome, 'success');
  await until(async () => (await ok('alarm')).alarm.state.phase === 'armed', 'PIN arms through Matter');
  assert.equal((await type('-004281')).result.outcome, 'failed');
  assert.equal((await ok('alarm')).alarm.state.phase, 'armed');
  await ok('alarm', 'arm', { modeId: mode.id, arm: false });
  const fingerprints = (await ok('keypad')).controller.trustIds;
  alarm = await ok('alarm'); const trusted = alarm.controllers.find((c) => fingerprints.includes(c.id));
  assert.ok(trusted, 'authenticated keypad fabric is discoverable from the server');
  await ok('alarm', 'settings', { ...alarm.alarm.settings, trustedControllers: [trusted.id] });
  assert.equal((await type('+004281')).result.outcome, 'success');
  const homeDisarm = bridge.endpoints.find((e) => e.number === disarmEndpoint).commandsOf(OnOffClient);
  await assert.rejects(homeDisarm.on());
  assert.equal((await ok('alarm')).alarm.state.phase, 'armed');
  assert.equal((await type('-778899')).result.outcome, 'denied');
  assert.equal((await type('-004281')).result.outcome, 'success');
  assert.equal((await ok('alarm')).alarm.state.phase, 'disarmed');
  console.log('PIN → Matter → armement/désarmement validés ; Maison reste interdite et le code invité ne désarme pas.');
  assert.equal((await type('*778899')).result.outcome, 'success'); assert.equal(lamp.endpoints.find((e) => e.number === 1).stateOf(OnOffClient).onOff, true);
  assert.equal((await type('/004281')).result.outcome, 'success'); assert.equal(lamp.endpoints.find((e) => e.number === 1).stateOf(OnOffClient).onOff, false);
  assert.match((await api('keypad', 'remove-credential', { id: family.id })).error, /Retire/);
  assert.match((await api('keypad', 'route', { name: 'Double', prefix: '+', enabled: true, credentialIds: null, operations: [{ peer: controlled.id, endpoint: 1, command: 'on' }] })).error, /utilisée/);
  console.log('Plugin indépendant : une lampe Matter commandée par deux codes et deux séquences ; aucune API d’alarme utilisée pour les commandes.');
  const state = await ok('keypad');
  await ok('keypad', 'settings', { settings: { ...state.settings, usbEnabled: true } });
  await until(async () => (await ok('keypad')).usb.error, 'absent USB reported');
  assert.equal((await type('+004281')).result.outcome, 'success');
  assert.equal((await type('-004281')).result.outcome, 'success');
  await ok('keypad', 'settings', { settings: state.settings });
  const before = await ok('keypad');
  writeFileSync('/test/restart', '');
  await until(() => existsSync('/test/restarted'), 'restart signal', 40000);
  const after = await until(async () => {
    const data = await api('keypad'); return data.peers?.length === 2 && data.peers.every((p) => p.connected) && data;
  }, 'restored subscriptions', 40000);
  assert.deepEqual(after.routes, before.routes); assert.deepEqual(after.credentials, before.credentials);
  assert.deepEqual(after.controller.trustIds, before.controller.trustIds);
  assert.equal(after.input.entered, 0); assert.equal(after.history.length, before.history.length);
  assert.equal((await type('+004281')).result.outcome, 'success');
  assert.equal((await type('-004281')).result.outcome, 'success');
  assert.equal((await type('*778899')).result.outcome, 'success');
  assert.equal((await type('/778899')).result.outcome, 'success');
  console.log('Redémarrage : codes, séquences, confiance, jumelages et commandes conservés ; USB absent sans bloquer le pavé web.');
} finally {
  for (const node of nodes.reverse()) await node.close().catch(() => {});
}
