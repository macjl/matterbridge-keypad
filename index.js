import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MatterbridgeDynamicPlatform } from 'matterbridge';
import { ControllerBehavior, NetworkClient, Seconds, ServerNode } from 'matterbridge/matter';
import { ManualPairingCodeCodec } from 'matterbridge/matter/types';
import { BasicInformationClient, BridgedDeviceBasicInformationClient, OnOffClient } from 'matterbridge/matter/behaviors';
import { Store, validSettings } from './store.js';
import { makeCredential, matches } from './credentials.js';
import { KeypadEngine, selectorPattern } from './engine.js';
import { UsbInput } from './input.js';
import { commandsOf, executeOperation, validOperation } from './actions.js';
import { hasAudioProfiles, readAudioProfiles } from './content.js';

const methods = new Set(['status', 'key', 'clear', 'settings', 'credential', 'remove-credential', 'route', 'remove-route', 'pair-device', 'remove-device']);
const publicCredential = ({ id, name, enabled }) => ({ id, name, enabled });
const fingerprint = (fabric) => createHash('sha256').update(Buffer.from(fabric.rootPublicKey)).update(String(fabric.fabricId)).digest('hex');

export default function initialize(matterbridge, log, config) { return new KeypadPlatform(matterbridge, log, config); }

class KeypadPlatform extends MatterbridgeDynamicPlatform {
  connected = new Set();
  catalogs = new Map();
  configuring = false;
  closing = false;
  refreshedAt = 0;

  async onStart() {
    await this.ready;
    if (!this.verifyMatterbridgeVersion('3.11.2', false)) throw new Error('Matterbridge 3.11.2 ou ultérieur est requis pour protéger les API du plugin.');
    this.store = new Store(join(this.matterbridge.matterbridgeDirectory, `${this.name}.json`));
    await this.store.start();
    this.engine = new KeypadEngine(this.store, (operation) => this.execute(operation));
    this.usb = new UsbInput((key) => {
      if (!this.configuring) void this.engine.key(`usb:${this.store.data.settings.devicePath}`, key).catch((error) => this.log.error(`Clavier USB : ${error.message}`));
    }, () => this.engine.clear(`usb:${this.store.data.settings.devicePath}`));
    this.controller = await ServerNode.create(ServerNode.RootEndpointWithoutGroupcast.with(ControllerBehavior), {
      id: 'keypad-controller', commissioning: { enabled: false }, network: { port: 0 },
      controller: { adminFabricLabel: 'Matterbridge Keypad' }, subscriptions: { persistenceEnabled: false },
    });
    for (const peer of this.controller.peers.commissioned) this.observe(peer);
    await this.controller.start();
    await this.usb.start(this.store.data.settings);
    this.log.info('Clavier prêt · pavé web, entrée USB optionnelle et commandes Matter.');
  }

  observe(peer) {
    peer.eventsOf(NetworkClient).subscriptionStatusChanged.on((active) => {
      if (active) { this.connected.add(peer.id); void this.refresh(); }
      else this.connected.delete(peer.id);
    });
    peer.lifecycle.offline.on(() => this.connected.delete(peer.id));
  }

  label(peer, endpoint) {
    const direct = endpoint.maybeStateOf(BridgedDeviceBasicInformationClient)?.nodeLabel || endpoint.maybeStateOf(BasicInformationClient)?.nodeLabel;
    const descriptor = endpoint.maybeStateOf('descriptor');
    const tag = descriptor?.tagList?.find((item) => item.label)?.label;
    if (tag) return direct && direct !== tag ? `${direct} · ${tag}` : tag;
    if (direct) return direct;
    if (descriptor?.deviceTypeList?.some(({ deviceType }) => Number(deviceType) === 0x22)) {
      return (endpoint.owner?.maybeStateOf(BridgedDeviceBasicInformationClient)?.nodeLabel || 'Lecteur') + ' · Haut-parleur';
    }
    return peer.maybeStateOf(BasicInformationClient)?.nodeLabel || peer.maybeStateOf(BasicInformationClient)?.productName || 'Accessoire Matter';
  }

  async refresh(force = false) {
    if (!this.controller?.lifecycle.isOnline || this.closing) return;
    if (this.refreshing) return this.refreshing;
    if (!force && Date.now() - this.refreshedAt < 30000) return;
    this.refreshing = (async () => {
      for (const peer of this.controller.peers.commissioned) {
        if (!peer.lifecycle.isConnected) continue;
        for (const endpoint of peer.endpoints) if (hasAudioProfiles(endpoint)) {
          try { this.catalogs.set(`${peer.id}:${endpoint.number}`, await readAudioProfiles(endpoint)); }
          catch (error) { this.log.warn(`Profils audio : ${error.message}`); }
        }
      }
      this.refreshedAt = Date.now();
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  status(source) {
    const { settings, credentials, routes, history } = this.store.data;
    return {
      settings, credentials: credentials.map(publicCredential), routes, history, input: this.engine.view(source), usb: this.usb.status,
      controller: { label: 'Matterbridge Keypad', trustIds: this.controller.stateOf('operationalCredentials').fabrics.map(fingerprint) },
      peers: this.controller.peers.commissioned.map((peer) => ({
        id: peer.id, label: peer.maybeStateOf(BasicInformationClient)?.nodeLabel || peer.maybeStateOf(BasicInformationClient)?.productName || peer.id,
        connected: this.connected.has(peer.id),
        endpoints: peer.endpoints.map((endpoint) => ({ number: endpoint.number, label: this.label(peer, endpoint),
          on: endpoint.maybeStateOf(OnOffClient)?.onOff ?? null,
          commands: commandsOf(endpoint, this.catalogs.get(`${peer.id}:${endpoint.number}`)),
        })).filter((endpoint) => endpoint.commands.length),
      })),
    };
  }

  async execute(operation) {
    await executeOperation(this.controller, operation);
    if (['on', 'off', 'mute', 'unmute'].includes(operation.command)) {
      const endpoint = this.controller.peers.get(operation.peer)?.endpoints.find((e) => e.number === operation.endpoint);
      const expected = operation.command === 'on' || operation.command === 'unmute';
      const deadline = Date.now() + 4000;
      while (endpoint?.maybeStateOf(OnOffClient)?.onOff !== expected) {
        if (Date.now() >= deadline) throw new Error('La commande est envoyée, mais l’état attendu n’est pas confirmé.');
        await delay(50);
      }
    }
  }

  async onFetch(method, path, _query, body) {
    if (method !== 'POST' || !methods.has(path)) return undefined;
    if (!this.controller?.lifecycle.isOnline || this.closing) return { error: 'Le contrôleur démarre ou est arrêté.' };
    const session = typeof body.session === 'string' && /^[a-zA-Z0-9-]{16,64}$/.test(body.session) ? body.session : 'configuration';
    const source = `web:${session}`;
    try {
      if (path === 'status') {
        if (body.refresh === true) await this.refresh(true); else void this.refresh();
        return this.status(source);
      }
      if (path === 'key' || path === 'clear') {
        if (this.configuring) return { error: 'Une configuration est en cours.' };
        if (session === 'configuration') return { error: 'Session de pavé invalide.' };
        const result = await this.engine.key(source, path === 'clear' ? 'Escape' : body.symbol);
        return { ...this.status(source), result };
      }
      if (this.configuring || this.engine.processing) return { error: 'Attends la fin de la commande ou de la configuration.' };
      this.configuring = true;
      try { await this.configure(path, body); }
      finally { this.configuring = false; }
      return this.status(source);
    } catch (error) { return { error: error.message }; }
  }

  async configure(path, body) {
    if (path === 'settings') {
      if (!validSettings(body.settings)) throw new Error('Vérifie le périphérique et les délais du clavier.');
      this.engine.clearAll();
      await this.store.update((data) => ({ ...data, settings: { ...body.settings } }));
      await this.usb.start(this.store.data.settings);
      return;
    }
    if (path === 'credential') {
      const previous = this.store.data.credentials.find((c) => c.id === body.id);
      if (body.id !== undefined && !previous) throw new Error('Code introuvable.');
      if (!previous && this.store.data.credentials.length >= 32) throw new Error('La limite est de 32 codes.');
      const pin = body.pin ?? '';
      if (pin) for (const credential of this.store.data.credentials) {
        if (credential.id !== body.id && await matches(pin, credential)) throw new Error('Ce code est déjà enregistré.');
      }
      const saved = await makeCredential({ name: body.name, pin, enabled: body.enabled }, previous);
      if (this.store.data.credentials.some((c) => c.id !== saved.id && c.name.toLowerCase() === saved.name.toLowerCase())) throw new Error('Ce nom de code est déjà utilisé.');
      await this.store.update((data) => ({ ...data, credentials: previous ? data.credentials.map((c) => c.id === saved.id ? saved : c) : [...data.credentials, saved] }));
      this.engine.clearAll(); return;
    }
    if (path === 'remove-credential') {
      if (this.store.data.routes.some((route) => route.credentialIds?.includes(body.id))) throw new Error('Retire d’abord ce code des séquences associées.');
      await this.store.update((data) => ({ ...data, credentials: data.credentials.filter((c) => c.id !== body.id) }));
      this.engine.clearAll(); return;
    }
    if (path === 'route') {
      const previous = this.store.data.routes.find((r) => r.id === body.id);
      if (body.id !== undefined && !previous) throw new Error('Séquence introuvable.');
      if (!previous && this.store.data.routes.length >= 128) throw new Error('La limite est de 128 séquences.');
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80 || !selectorPattern.test(body.prefix)
        || typeof body.enabled !== 'boolean' || !Array.isArray(body.operations) || !body.operations.length || body.operations.length > 100
        || !(body.credentialIds === null || (Array.isArray(body.credentialIds) && body.credentialIds.length > 0
          && body.credentialIds.every((id) => this.store.data.credentials.some((c) => c.id === id))))) throw new Error('Vérifie le nom, la séquence, les codes et les commandes.');
      if (this.store.data.routes.some((r) => r.id !== body.id && r.prefix === body.prefix)) throw new Error('Cette séquence est déjà utilisée.');
      const operations = body.operations.map((operation) => {
        if (!validOperation(operation)) throw new Error('Commande Matter invalide.');
        const { peer, endpoint, command, value } = operation;
        const node = this.controller.peers.get(peer), part = node?.endpoints.find((e) => e.number === endpoint);
        const capability = part && commandsOf(part, this.catalogs.get(`${peer}:${endpoint}`)).find((c) => c.id === command);
        const old = previous?.operations.find((o) => o.peer === peer && o.endpoint === endpoint && o.command === command && o.value === value);
        if (!capability && !old) throw new Error('Commande indisponible sur cet accessoire.');
        if (capability?.min !== undefined && (value < capability.min || value > capability.max)) throw new Error('Valeur hors limites.');
        const choice = capability?.choices?.find((c) => c.value === value);
        if (command === 'profile' && !choice && !old) throw new Error('Profil audio indisponible ; actualise la liste.');
        return { peer, endpoint, command, ...(value === undefined ? {} : { value }), label: part ? this.label(node, part) : old?.label || peer,
          ...(command === 'profile' ? { valueLabel: choice?.label || old?.valueLabel || 'Profil indisponible' } : {}) };
      });
      const route = { id: previous?.id ?? randomUUID().replaceAll('-', ''), name: body.name.trim(), prefix: body.prefix, enabled: body.enabled, credentialIds: body.credentialIds, operations };
      await this.store.update((data) => ({ ...data, routes: previous ? data.routes.map((r) => r.id === route.id ? route : r) : [...data.routes, route] }));
      this.engine.clearAll(); return;
    }
    if (path === 'remove-route') {
      await this.store.update((data) => ({ ...data, routes: data.routes.filter((r) => r.id !== body.id) })); this.engine.clearAll(); return;
    }
    if (path === 'pair-device') {
      const code = typeof body.code === 'string' ? body.code.trim().replace(/[ -]/g, '') : '';
      if (!/^(?:\d{11}|\d{21})$/.test(code)) throw new Error('Code de partage Matter invalide.');
      const { shortDiscriminator } = ManualPairingCodeCodec.decode(code);
      let peer;
      try {
        // Let matter.js allocate a different identity per discovery candidate.
        // A short manual discriminator can match several devices (including stale mDNS entries).
        peer = await this.controller.peers.commission({ pairingCode: code, shortDiscriminator,
          discoveryCapabilities: { onIpNetwork: true }, autoSubscribe: true, timeout: Seconds(30) });
      } catch { throw new Error('Jumelage échoué. Vérifie le code de partage et la connexion de l’appareil.'); }
      this.observe(peer);
      if (await peer.act((agent) => agent.get(NetworkClient).subscriptionActive)) this.connected.add(peer.id);
      await this.refresh(true); return;
    }
    if (path === 'remove-device') {
      const peer = typeof body.peer === 'string' && this.controller.peers.get(body.peer);
      if (!peer) throw new Error('Appareil introuvable.');
      if (this.store.data.routes.some((route) => route.operations.some((o) => o.peer === body.peer))) throw new Error('Retire d’abord les commandes de cet appareil des séquences.');
      await peer.decommission(); this.connected.delete(body.peer);
    }
  }

  async onShutdown(reason) {
    this.closing = true;
    try { await this.usb?.stop(); await this.engine?.stop(); await this.refreshing; await this.store?.queue; await this.controller?.close(); }
    finally { await super.onShutdown(reason); }
  }
}
