import { randomBytes, randomUUID, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(derive);
export function validPin(pin) { return typeof pin === 'string' && /^[0-9]{4,12}$/.test(pin); }
export async function matches(pin, credential) {
  if (!validPin(pin) || credential.algorithm !== 'scrypt-v1') return false;
  const hash = await scrypt(pin, Buffer.from(credential.salt, 'hex'), 32, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(hash, Buffer.from(credential.hash, 'hex'));
}
export async function makeCredential({ name, pin, enabled = true }, previous) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 64 || typeof enabled !== 'boolean') throw new Error('Vérifie le nom et l’activation du code.');
  if ((!previous || pin !== '') && !validPin(pin)) throw new Error('Le code doit contenir 4 à 12 chiffres.');
  if (previous && pin === '') return { ...previous, name: name.trim(), enabled };
  const salt = randomBytes(16);
  const hash = await scrypt(pin, salt, 32, { N: 16384, r: 8, p: 1 });
  return { id: previous?.id ?? randomUUID().replaceAll('-', ''), name: name.trim(), enabled, algorithm: 'scrypt-v1', salt: salt.toString('hex'), hash: hash.toString('hex') };
}
