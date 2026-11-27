import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, validSettings } from '../store.js';
import { makeCredential, matches } from '../credentials.js';
import { KeypadEngine } from '../engine.js';
import { InputDecoder, UsbInput } from '../input.js';

async function fixture(t, execute = async () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'keypad-test-'));
  const store = new Store(join(directory, 'state.json')); await store.start();
  const credential = await makeCredential({ name: 'Famille', pin: '004281' });
  const route = { id: 'a'.repeat(32), name: 'Armer', prefix: '+', credentialIds: null, enabled: true, operations: [{ peer: 'test', endpoint: 1, command: 'on' }] };
  await store.update((d) => ({ ...d, credentials: [credential], routes: [route] }));
  const engine = new KeypadEngine(store, execute);
  t.after(async () => { await engine.stop(); await rm(directory, { recursive: true, force: true }); });
  return { store, engine, credential, route };
}
async function type(engine, value, source = 'web:one') {
  for (const key of value) await engine.key(source, key);
  return engine.key(source, 'Enter');
}
test('PINs preserve leading zeroes, salted hash, rename without replacing code', async () => {
  const c = await makeCredential({ name: 'Maison', pin: '001234' });
  assert.equal(await matches('001234', c), true);
  assert.equal(await matches('1234', c), false);
  assert.equal(await matches(1234, c), false);
  assert.notEqual((await makeCredential({ name: 'Autre', pin: '001234' })).hash, c.hash);
  assert.ok(!JSON.stringify(c).includes('001234'));
  const renamed = await makeCredential({ name: 'Renommé', pin: '', enabled: false }, c);
  assert.equal(renamed.hash, c.hash); assert.equal(renamed.enabled, false);
  await assert.rejects(makeCredential({ name: 'Court', pin: '12' }));
});
test('no action before validation; sessions remain separate and state never exposes digits', async (t) => {
  const calls = []; const { engine, store } = await fixture(t, (operation) => calls.push(operation));
  for (const key of '+004281') await engine.key('web:one', key);
  assert.equal(calls.length, 0);
  assert.equal(engine.view('web:one').entered, 6); assert.equal(engine.view('web:two').entered, 0);
  assert.equal((await engine.key('web:two', 'Enter')).outcome, 'invalid');
  assert.equal((await engine.key('web:one', 'Enter')).outcome, 'success');
  assert.equal(calls.length, 1); assert.equal(engine.view('web:one').entered, 0);
  assert.ok(!JSON.stringify({ view: engine.view('web:one'), data: store.data }).includes('004281'));
  await assert.rejects(engine.key('web:one', {}), /Touche invalide/);
});
test('global lock survives restart and applies across web and USB; cooldown resets', async (t) => {
  let calls = 0; const { engine, store } = await fixture(t, () => calls++);
  await store.update((d) => ({ ...d, settings: { ...d.settings, maxAttempts: 2, lockSeconds: 5 } }));
  assert.equal((await type(engine, '+111111')).outcome, 'denied');
  assert.equal((await type(engine, '+222222', 'usb:dedicated')).outcome, 'denied');
  assert.equal((await engine.key('web:two', '+')).outcome, 'locked'); assert.equal(calls, 0);
  const restarted = new Store(store.path); await restarted.start();
  assert.equal(restarted.data.security.failures, 2); assert.ok(restarted.data.security.until > Date.now());
  await store.update((d) => ({ ...d, security: { ...d.security, until: Date.now() - 1 } }));
  assert.equal((await type(engine, '+004281')).outcome, 'success'); assert.equal(calls, 1);
  assert.equal(store.data.security.failures, 0);
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
});
test('credential restrictions and disabled codes block otherwise correct PINs', async (t) => {
  let calls = 0; const { engine, store, credential } = await fixture(t, () => calls++);
  const guest = await makeCredential({ name: 'Invité', pin: '778899' });
  await store.update((d) => ({ ...d, credentials: [...d.credentials, guest], routes: d.routes.map((r) => ({ ...r, credentialIds: [credential.id] })) }));
  assert.equal((await type(engine, '+778899')).outcome, 'denied');
  await store.update((d) => ({ ...d, credentials: d.credentials.map((c) => ({ ...c, enabled: false })) }));
  assert.equal((await type(engine, '+004281')).outcome, 'denied'); assert.equal(calls, 0);
});
test('sequences, corrections, timeout and new prefix after digits', async (t) => {
  const { engine, store, route } = await fixture(t);
  await store.update((d) => ({ ...d, routes: [...d.routes, { ...route, id: 'b'.repeat(32), prefix: '++', name: 'Nuit' }] }));
  for (const key of '++00') await engine.key('web:one', key);
  assert.equal(engine.view('web:one').route, 'Nuit');
  await engine.key('web:one', 'Backspace'); assert.equal(engine.view('web:one').entered, 1);
  await engine.key('web:one', '-'); assert.equal(engine.view('web:one').prefix, '-'); assert.equal(engine.view('web:one').entered, 0);
  await engine.key('web:one', 'Escape'); assert.equal(engine.view('web:one').prefix, '');
  assert.equal((await type(engine, '++004281')).outcome, 'success');
  store.data.settings.inputSeconds = .02;
  await engine.key('web:one', '+'); await engine.key('web:one', '0');
  await delay(40); assert.equal(engine.view('web:one').entered, 0); assert.equal(engine.view('web:one').prefix, '');
});
test('command failures stop a sequence; concurrent execution is blocked', async (t) => {
  let release, count = 0;
  const { engine, store, route } = await fixture(t, async () => { count++; await new Promise((resolve) => { release = resolve; }); throw new Error('Refus Matter'); });
  await store.update((d) => ({ ...d, routes: [{ ...route, operations: [...route.operations, ...route.operations] }] }));
  const result = type(engine, '+004281');
  while (!release) await delay(5);
  assert.equal((await engine.key('usb:dedicated', '+')).outcome, 'busy');
  release(); assert.equal((await result).outcome, 'failed'); assert.equal(count, 1);
  assert.equal(store.data.history[0].outcome, 'failed');
});
function event(size, code, value = 1, type = 1) {
  const buffer = Buffer.alloc(size); buffer.writeUInt16LE(type, size - 8); buffer.writeUInt16LE(code, size - 6); buffer.writeInt32LE(value, size - 4); return buffer;
}
for (const size of [16, 24]) test(`evdev ${size}-byte records: fragmented input, repeat/release and dropped sync`, () => {
  const keys = []; let resets = 0;
  const decoder = new InputDecoder((key) => keys.push(key), () => resets++, size);
  const buffer = Buffer.concat([event(size, 78), event(size, 82), event(size, 79), event(size, 79, 2), event(size, 79, 0), event(size, 96)]);
  decoder.feed(buffer.subarray(0, 3)); decoder.feed(buffer.subarray(3, size + 1)); decoder.feed(buffer.subarray(size + 1));
  assert.deepEqual(keys, ['+', '0', '1', 'Enter']);
  decoder.feed(Buffer.concat([event(size, 3, 0, 0), event(size, 82), event(size, 0, 0, 0), event(size, 74)]));
  assert.equal(resets, 1); assert.deepEqual(keys, ['+', '0', '1', 'Enter', '-']);
});
test('simulated USB byte stream uses the same engine as virtual keypad', async (t) => {
  let calls = 0; const { engine } = await fixture(t, () => calls++);
  const sequence = [];
  const decoder = new InputDecoder((key) => sequence.push(key), () => engine.clear('usb:test'), 24);
  decoder.feed(Buffer.concat([78, 82, 82, 75, 80, 72, 79, 96].map((code) => event(24, code))));
  let result; for (const key of sequence) result = await engine.key('usb:test', key);
  assert.equal(result.outcome, 'success'); assert.equal(calls, 1);
});
test('disabled USB never opens a device, invalid settings or corrupt persisted routes fail closed', async (t) => {
  const { store } = await fixture(t);
  assert.equal(validSettings({ ...store.data.settings, devicePath: '/etc/passwd' }), false);
  assert.equal(validSettings({ ...store.data.settings, maxAttempts: 0 }), false);
  const usb = new UsbInput(() => { throw new Error('Unexpected USB key'); }, () => {});
  await usb.start(store.data.settings); assert.equal(usb.status.connected, false); await usb.stop();
  await store.update((d) => ({ ...d, routes: [{}] }));
  const corrupted = new Store(store.path); await assert.rejects(corrupted.start(), /Configuration/);
  assert.ok(!(await readFile(store.path, 'utf8')).includes('004281'));
});
