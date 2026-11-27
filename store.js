import { readFile, writeFile, rename } from 'node:fs/promises';

export const defaultSettings = {
  usbEnabled: false, devicePath: '/dev/input/alarm-keypad', exclusive: true,
  inputSeconds: 15, maxAttempts: 5, lockSeconds: 30,
};
export function validSettings(settings) {
  return settings && typeof settings.usbEnabled === 'boolean' && typeof settings.exclusive === 'boolean'
    && typeof settings.devicePath === 'string' && /^\/dev\/input\/(?:by-id\/|by-path\/)?[a-zA-Z0-9_.:+-]{1,160}$/.test(settings.devicePath)
    && [[settings.inputSeconds, 5, 120], [settings.maxAttempts, 1, 20], [settings.lockSeconds, 5, 3600]]
      .every(([value, min, max]) => Number.isInteger(value) && value >= min && value <= max);
}
export class Store {
  queue = Promise.resolve();
  constructor(path) { this.path = path; }
  async start() {
    this.data = { version: 1, settings: { ...defaultSettings }, credentials: [], routes: [], security: { failures: 0, until: 0 }, history: [] };
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      if (saved.version !== 1 || !validSettings(saved.settings) || !Array.isArray(saved.credentials) || !Array.isArray(saved.routes)
        || !Array.isArray(saved.history) || !Number.isInteger(saved.security?.failures) || !Number.isFinite(saved.security?.until)
        || saved.security.failures < 0 || saved.security.until < 0 || saved.credentials.length > 32 || saved.routes.length > 128
        || !saved.credentials.every((c) => /^[0-9a-f]{32}$/.test(c.id) && typeof c.name === 'string' && typeof c.enabled === 'boolean'
          && c.algorithm === 'scrypt-v1' && /^[0-9a-f]{32}$/.test(c.salt) && /^[0-9a-f]{64}$/.test(c.hash))
        || !saved.routes.every((r) => /^[0-9a-f]{32}$/.test(r.id) && typeof r.name === 'string' && typeof r.enabled === 'boolean'
          && /^[+*/.\-]{1,4}$/.test(r.prefix) && (r.credentialIds === null || Array.isArray(r.credentialIds) && r.credentialIds.length > 0
            && r.credentialIds.every((id) => saved.credentials.some((c) => c.id === id)))
          && Array.isArray(r.operations) && r.operations.length > 0 && r.operations.length <= 100
          && r.operations.every((o) => typeof o.peer === 'string' && Number.isInteger(o.endpoint) && typeof o.command === 'string'))
        || new Set(saved.credentials.map((c) => c.id)).size !== saved.credentials.length
        || new Set(saved.routes.map((r) => r.prefix)).size !== saved.routes.length) throw new Error('Configuration du clavier invalide.');
      this.data = saved;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  update(change) {
    const result = this.queue.then(async () => {
      const next = change(this.data);
      await writeFile(this.path + '.tmp', JSON.stringify(next), { mode: 0o600, flush: true });
      await rename(this.path + '.tmp', this.path);
      this.data = next;
      return next;
    });
    this.queue = result.catch(() => {});
    return result;
  }
  event(outcome, message, source) {
    return this.update((data) => ({ ...data, history: [{ at: Date.now(), outcome, message, source }, ...data.history].slice(0, 50) }));
  }
}
