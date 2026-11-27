import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const keyMap = new Map([
  [82, '0'], [79, '1'], [80, '2'], [81, '3'], [75, '4'], [76, '5'], [77, '6'], [71, '7'], [72, '8'], [73, '9'],
  [110, '0'], [107, '1'], [108, '2'], [109, '3'], [105, '4'], [106, '6'], [102, '7'], [103, '8'], [104, '9'],
  [11, '0'], [2, '1'], [3, '2'], [4, '3'], [5, '4'], [6, '5'], [7, '6'], [8, '7'], [9, '8'], [10, '9'],
  [78, '+'], [74, '-'], [55, '*'], [98, '/'], [83, '.'], [28, 'Enter'], [96, 'Enter'], [14, 'Backspace'], [1, 'Escape'], [111, 'Escape'],
]);
export class InputDecoder {
  pending = Buffer.alloc(0);
  dropped = false;
  constructor(onKey, onReset, eventSize = ['arm', 'ia32'].includes(process.arch) ? 16 : 24) { this.onKey = onKey; this.onReset = onReset; this.eventSize = eventSize; }
  feed(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= this.eventSize) {
      const offset = this.eventSize - 8;
      const type = this.pending.readUInt16LE(offset), code = this.pending.readUInt16LE(offset + 2), value = this.pending.readInt32LE(offset + 4);
      this.pending = this.pending.subarray(this.eventSize);
      if (type === 0 && code === 3) { this.dropped = true; this.onReset(); }
      if (type === 0 && code === 0) this.dropped = false;
      if (!this.dropped && type === 1 && value === 1 && keyMap.has(code)) this.onKey(keyMap.get(code));
    }
  }
}
export class UsbInput {
  status = { enabled: false, connected: false, name: '', error: null };
  stopped = true;
  constructor(onKey, onReset) { this.onKey = onKey; this.onReset = onReset; }
  async start(settings) {
    await this.stop();
    this.status = { enabled: settings.usbEnabled, connected: false, name: '', error: null };
    if (!settings.usbEnabled) return;
    this.stopped = false; this.settings = settings;
    this.decoder = new InputDecoder(this.onKey, this.onReset);
    this.polling = this.poll();
  }
  async poll() {
    if (this.stopped) return;
    try {
      if (!this.handle) {
        const native = require('./native/evdev.node');
        this.handle = await open(this.settings.devicePath, constants.O_RDONLY | constants.O_NONBLOCK);
        if (!(await this.handle.stat()).isCharacterDevice()) throw new Error('Le périphérique n’est pas une entrée evdev.');
        const name = native.name(this.handle.fd);
        if (this.expectedName && this.expectedName !== name) throw new Error('Le périphérique a changé ; vérifie le pavé USB.');
        if (this.settings.exclusive) native.grab(this.handle.fd, true);
        this.native = native; this.expectedName = name;
        this.status = { enabled: true, connected: true, name, error: null };
      }
      const buffer = Buffer.alloc(24 * 32);
      try {
        const { bytesRead } = await this.handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) throw new Error('Le pavé USB a été déconnecté.');
        this.decoder.feed(buffer.subarray(0, bytesRead));
      } catch (error) { if (error.code !== 'EAGAIN' && error.code !== 'EWOULDBLOCK') throw error; }
    } catch (error) {
      await this.closeHandle(); this.decoder.pending = Buffer.alloc(0); this.decoder.dropped = false; this.onReset();
      this.status.connected = false; this.status.error = error.message;
    }
    if (!this.stopped) this.timer = setTimeout(() => { this.polling = this.poll(); }, this.status.connected ? 25 : 2000);
  }
  async closeHandle() {
    if (!this.handle) return;
    try { if (this.native && this.settings?.exclusive) this.native.grab(this.handle.fd, false); } catch {}
    await this.handle.close().catch(() => {}); this.handle = undefined;
  }
  async stop() {
    this.stopped = true; clearTimeout(this.timer); await this.polling;
    await this.closeHandle(); this.onReset();
    this.expectedName = undefined; this.status.connected = false;
  }
}
