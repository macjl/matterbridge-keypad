import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
if (process.platform !== 'linux') throw new Error('Le lecteur USB evdev nécessite Linux. Le pavé web reste utilisable sans ce module.');
await mkdir('native', { recursive: true });
const include = resolve(dirname(process.execPath), '../include/node');
const result = spawnSync(process.env.CC || 'cc', ['-shared', '-fPIC', '-Wall', '-Wextra', '-Werror', '-I' + include, 'native/evdev.c', '-o', 'native/evdev.node'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
