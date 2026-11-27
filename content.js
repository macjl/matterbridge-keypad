import { ContentLauncherClient, FixedLabelClient } from 'matterbridge/matter/behaviors';
import { ContentLauncher } from 'matterbridge/matter/clusters';

const format = 'audio-profiles.v1';
export function hasAudioProfiles(endpoint) {
  return endpoint?.maybeStateOf(FixedLabelClient)?.labelList?.some((label) => label.label === 'audioProfiles' && label.value === 'v1')
    && endpoint.maybeStateOf(ContentLauncherClient)?.acceptedCommandList?.includes(ContentLauncher.commands.launchContent.id);
}

export async function readAudioProfiles(endpoint) {
  if (!hasAudioProfiles(endpoint)) return [];
  const profiles = [];
  let offset = 0;
  for (let page = 0; page < 64; page++) {
    const response = await endpoint.commandsOf(ContentLauncherClient).launchContent({
      search: { parameterList: [{ type: ContentLauncher.Parameter.Any, value: '*' }] }, autoPlay: false, data: `${format}:${offset}`,
    });
    if (response.status !== ContentLauncher.Status.Success) throw new Error('Catalogue de profils indisponible.');
    const data = JSON.parse(response.data);
    if (data.kind !== format || !Array.isArray(data.profiles)
      || !data.profiles.every((p) => typeof p.id === 'string' && /^[a-z0-9-]{1,40}$/.test(p.id) && typeof p.name === 'string' && Buffer.byteLength(p.name) <= 48)) {
      throw new Error('Catalogue de profils invalide.');
    }
    profiles.push(...data.profiles);
    if (profiles.length > 64 || new Set(profiles.map((p) => p.id)).size !== profiles.length) throw new Error('Catalogue de profils invalide.');
    if (data.next === null) return profiles;
    if (!Number.isInteger(data.next) || data.next <= offset) throw new Error('Page de profils invalide.');
    offset = data.next;
  }
  throw new Error('Catalogue de profils incomplet.');
}

export async function playAudioProfile(endpoint, id) {
  const response = await endpoint.commandsOf(ContentLauncherClient).launchContent({
    search: { parameterList: [{ type: ContentLauncher.Parameter.Any, value: id }] }, autoPlay: true,
  });
  if (response.status !== ContentLauncher.Status.Success) throw new Error(`Profil audio refusé (statut ${response.status}).`);
}
