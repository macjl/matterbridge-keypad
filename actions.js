import { ColorControlClient, LevelControlClient, MediaPlaybackClient, OnOffClient } from 'matterbridge/matter/behaviors';
import { ColorControl, LevelControl, MediaPlayback, OnOff } from 'matterbridge/matter/clusters';
import { hasAudioProfiles, playAudioProfile } from './content.js';

const definitions = {
  on: { label: 'Allumer', client: OnOffClient, cluster: OnOff, command: 'on' },
  off: { label: 'Éteindre', client: OnOffClient, cluster: OnOff, command: 'off' },
  brightness: { label: 'Luminosité (%)', client: LevelControlClient, cluster: LevelControl, command: 'moveToLevelWithOnOff', min: 0, max: 100 },
  color: { label: 'Couleur', client: ColorControlClient, cluster: ColorControl, command: 'moveToHueAndSaturation' },
  temperature: { label: 'Température du blanc (K)', client: ColorControlClient, cluster: ColorControl, command: 'moveToColorTemperature' },
  play: { label: 'Lire / reprendre', client: MediaPlaybackClient, cluster: MediaPlayback, command: 'play' },
  pause: { label: 'Mettre en pause', client: MediaPlaybackClient, cluster: MediaPlayback, command: 'pause' },
  stop: { label: 'Arrêter la lecture', client: MediaPlaybackClient, cluster: MediaPlayback, command: 'stop' },
  volume: { label: 'Volume (%)', client: LevelControlClient, cluster: LevelControl, command: 'moveToLevel', min: 0, max: 100, speaker: true },
  mute: { label: 'Couper le son', client: OnOffClient, cluster: OnOff, command: 'off', speaker: true },
  unmute: { label: 'Rétablir le son', client: OnOffClient, cluster: OnOff, command: 'on', speaker: true },
};

const noValue = new Set(['on', 'off', 'play', 'pause', 'stop', 'mute', 'unmute']);

function isSpeaker(endpoint) {
  return endpoint?.maybeStateOf('descriptor')?.deviceTypeList?.some(({ deviceType }) => Number(deviceType) === 0x22) ?? false;
}

function supported(endpoint, definition) {
  const state = endpoint?.maybeStateOf(definition.client);
  return state?.acceptedCommandList?.includes(definition.cluster.commands[definition.command].id) ?? false;
}

function colorCommand(endpoint) {
  if (supported(endpoint, definitions.color)) return 'moveToHueAndSaturation';
  if (supported(endpoint, { ...definitions.color, command: 'moveToColor' })) return 'moveToColor';
}

export function commandsOf(endpoint, profiles = []) {
  const speaker = isSpeaker(endpoint);
  const commands = Object.entries(definitions).flatMap(([id, definition]) => {
    if (definition.speaker && !speaker) return [];
    if (speaker && ['on', 'off', 'brightness'].includes(id)) return [];
    if (id === 'color' ? !colorCommand(endpoint) : !supported(endpoint, definition)) return [];
    const command = { id, label: definition.label };
    if (definition.min !== undefined) Object.assign(command, { min: definition.min, max: definition.max });
    if (id === 'temperature') {
      const state = endpoint.stateOf(ColorControlClient);
      Object.assign(command, {
        min: Math.ceil(1e6 / (state.colorTempPhysicalMaxMireds || 1000)),
        max: Math.floor(1e6 / (state.colorTempPhysicalMinMireds || 50)),
      });
    }
    return [command];
  });
  if (hasAudioProfiles(endpoint)) commands.push({ id: 'profile', label: 'Lire un profil', choices: profiles.map(({ id, name }) => ({ value: id, label: name })) });
  return commands;
}

export function validOperation(operation) {
  const { peer, endpoint, command, value } = operation ?? {};
  if (typeof peer !== 'string' || !Number.isInteger(endpoint) || endpoint < 1 || endpoint > 65534 || (command !== 'profile' && !Object.hasOwn(definitions, command))) return false;
  if (command === 'profile') return typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value);
  if (noValue.has(command)) return value === undefined;
  if (command === 'color') return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  return Number.isInteger(value) && (['brightness', 'volume'].includes(command) ? value >= 0 && value <= 100 : value >= 1000 && value <= 20000);
}

export async function executeOperation(controller, operation) {
  const peer = controller.peers.get(operation.peer);
  const endpoint = peer?.endpoints.find(({ number }) => number === operation.endpoint);
  if (!peer?.lifecycle.isConnected || !endpoint) throw new Error('Appareil Matter indisponible.');
  const capability = commandsOf(endpoint).find(({ id }) => id === operation.command);
  if (!capability) throw new Error('Commande indisponible sur cet accessoire.');
  if (capability.min !== undefined && (operation.value < capability.min || operation.value > capability.max)) {
    throw new Error('Valeur hors des limites de cet accessoire.');
  }
  if (operation.command === 'profile') {
    await playAudioProfile(endpoint, operation.value);
    return;
  }
  const definition = definitions[operation.command];
  const commands = endpoint.commandsOf(definition.client);
  if (operation.command === 'color' && operation.value.toLowerCase() === '#000000') {
    await endpoint.commandsOf(OnOffClient).off();
    return;
  }
  if (noValue.has(operation.command)) {
    const response = await commands[definition.command]();
    if (definition.cluster === MediaPlayback && response?.status !== MediaPlayback.Status.Success) {
      const reason = response?.status === MediaPlayback.Status.NotAllowed ? ' Vérifie que le lecteur est allumé.' : '';
      throw new Error(`Commande audio refusée (statut ${response?.status ?? 'absent'}).${reason}`);
    }
    return;
  }
  if (operation.command === 'volume') {
    await commands.moveToLevel({ level: Math.round(operation.value * 254 / 100), transitionTime: 0, optionsMask: {}, optionsOverride: {} });
    return;
  }
  const options = { transitionTime: 0, optionsMask: { executeIfOff: true }, optionsOverride: { executeIfOff: true } };
  if (operation.command === 'brightness') {
    await commands.moveToLevelWithOnOff({ level: Math.round(operation.value * 254 / 100), ...options });
  } else if (operation.command === 'temperature') {
    await commands.moveToColorTemperature({ colorTemperatureMireds: Math.round(1e6 / operation.value), ...options });
  } else if (colorCommand(endpoint) === 'moveToHueAndSaturation') {
    await commands.moveToHueAndSaturation({ ...hueSaturation(operation.value), ...options });
  } else {
    await commands.moveToColor({ ...colorCoordinates(operation.value), ...options });
  }
}

function rgb(color) {
  return [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16) / 255);
}

function hueSaturation(color) {
  const [red, green, blue] = rgb(color);
  const max = Math.max(red, green, blue);
  const delta = max - Math.min(red, green, blue);
  let hue = 0;
  if (delta > 0) {
    if (max === red) hue = (green - blue) / delta;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
  }
  return { hue: Math.round(((hue + 6) % 6) * 254 / 6), saturation: max === 0 ? 0 : Math.round(delta / max * 254) };
}

function colorCoordinates(color) {
  const [red, green, blue] = rgb(color).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const x = red * 0.4124564 + green * 0.3575761 + blue * 0.1804375;
  const y = red * 0.2126729 + green * 0.7151522 + blue * 0.0721750;
  const z = red * 0.0193339 + green * 0.1191920 + blue * 0.9503041;
  const total = x + y + z;
  return { colorX: Math.round((total ? x / total : 0.3127) * 65536), colorY: Math.round((total ? y / total : 0.3290) * 65536) };
}
