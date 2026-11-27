import { matches } from './credentials.js';

export const selectorPattern = /^[+*/.\-]{1,4}$/;
const selectors = new Set(['+', '-', '*', '/', '.']);
export class KeypadEngine {
  sessions = new Map();
  processing = false;
  stopped = false;
  lastResult = null;
  constructor(store, execute) { this.store = store; this.execute = execute; }
  session(source) {
    let input = this.sessions.get(source);
    if (input?.expiresAt && input.expiresAt <= Date.now()) { this.clear(source); input = undefined; }
    if (!input) {
      if (this.sessions.size >= 32) this.clear(this.sessions.keys().next().value);
      input = { prefix: '', digits: '', expiresAt: 0 }; this.sessions.set(source, input);
    }
    return input;
  }
  clear(source) {
    const previous = this.sessions.get(source);
    if (previous) { clearTimeout(previous.timer); previous.digits = ''; }
    this.sessions.delete(source);
  }
  clearAll() { for (const source of this.sessions.keys()) this.clear(source); }
  view(source) {
    const input = this.sessions.get(source);
    const { until, failures } = this.store.data.security;
    return { prefix: input?.prefix ?? '', entered: input?.digits.length ?? 0, expiresAt: input?.expiresAt ?? 0,
      route: this.store.data.routes.find((r) => r.enabled && r.prefix === input?.prefix)?.name ?? '',
      busy: this.processing, lockedUntil: until > Date.now() ? until : 0, failures, lastResult: this.lastResult };
  }
  async key(source, key) {
    if (this.stopped) throw new Error('Le clavier est arrêté.');
    if (typeof key !== 'string' || !/^(?:[0-9+*/.\-]|Enter|Backspace|Escape)$/.test(key)) throw new Error('Touche invalide.');
    if (this.processing) return { outcome: 'busy', message: 'Une commande est en cours.' };
    if (this.store.data.security.until > Date.now()) { this.clear(source); return { outcome: 'locked', message: 'Clavier temporairement verrouillé.' }; }
    if (this.store.data.security.until) await this.store.update((d) => ({ ...d, security: { failures: 0, until: 0 } }));
    this.lastResult = null;
    if (key === 'Escape') { this.clear(source); return { outcome: 'input', message: 'Saisie effacée.' }; }
    const input = this.session(source);
    clearTimeout(input.timer);
    input.expiresAt = Date.now() + this.store.data.settings.inputSeconds * 1000;
    input.timer = setTimeout(() => this.clear(source), this.store.data.settings.inputSeconds * 1000);
    input.timer.unref?.();
    if (selectors.has(key)) {
      if (input.digits || input.prefix.length >= 4) { input.prefix = ''; input.digits = ''; }
      input.prefix += key;
    } else if (key === 'Backspace') {
      if (input.digits) input.digits = input.digits.slice(0, -1); else input.prefix = input.prefix.slice(0, -1);
    } else if (key !== 'Enter') {
      if (input.digits.length >= 12) { this.clear(source); return this.lastResult = { at: Date.now(), outcome: 'invalid', message: 'Saisie trop longue ; recommence.' }; }
      input.digits += key;
    } else {
      const route = this.store.data.routes.find((r) => r.enabled && r.prefix === input.prefix);
      const pin = input.digits;
      this.clear(source);
      if (!route) return this.lastResult = { at: Date.now(), outcome: 'invalid', message: 'Choisis une séquence configurée.' };
      this.processing = true;
      try { return await this.submit(source, route, pin); }
      finally { this.processing = false; }
    }
    return { outcome: 'input', message: '' };
  }
  async submit(source, route, pin) {
    const origin = source.startsWith('usb:') ? 'Clavier USB' : 'Pavé web';
    const credentials = this.store.data.credentials.filter((c) => c.enabled && (route.credentialIds === null || route.credentialIds.includes(c.id)));
    let credential;
    for (const candidate of credentials) if (await matches(pin, candidate)) { credential = candidate; break; }
    if (!credential) {
      await this.store.update((data) => {
        const failures = data.security.failures + 1;
        return { ...data, security: { failures, until: failures >= data.settings.maxAttempts ? Date.now() + data.settings.lockSeconds * 1000 : 0 } };
      });
      this.clearAll();
      await this.store.event('denied', `Code refusé · ${route.name}.`, origin);
      this.lastResult = { at: Date.now(), outcome: 'denied', message: 'Code refusé.' }; return this.lastResult;
    }
    await this.store.update((data) => ({ ...data, security: { failures: 0, until: 0 } }));
    try {
      for (const operation of route.operations) {
        if (this.stopped) throw new Error('Le clavier est arrêté.');
        await this.execute(operation);
      }
      await this.store.event('success', `Exécutée · ${route.name} · ${credential.name}.`, origin);
      this.lastResult = { at: Date.now(), outcome: 'success', message: `${route.name} : commande exécutée.` };
    } catch (error) {
      await this.store.event('failed', `Échec · ${route.name} · ${error.message}`, origin);
      this.lastResult = { at: Date.now(), outcome: 'failed', message: `Commande refusée ou indisponible : ${error.message}` };
    }
    return this.lastResult;
  }
  async stop() {
    this.stopped = true; this.clearAll();
    while (this.processing) await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
