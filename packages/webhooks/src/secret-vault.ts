import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function parseKey(keyMaterial: string): Buffer {
  const key = Buffer.from(keyMaterial, 'base64');
  if (key.length !== 32 || key.toString('base64') !== keyMaterial) {
    throw new Error('APP_ENCRYPTION_KEY must be a canonical base64 encoding of 32 random bytes');
  }
  return key;
}

export function encryptSecret(secret: string, keyMaterial: string): string {
  if (!secret) throw new TypeError('secret must not be empty');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', parseKey(keyMaterial), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptSecret(envelope: string, keyMaterial: string): string {
  const [version, ivPart, tagPart, ciphertextPart, extra] = envelope.split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !ciphertextPart || extra !== undefined) throw new TypeError('encrypted secret envelope is invalid');
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const ciphertext = Buffer.from(ciphertextPart, 'base64url');
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new TypeError('encrypted secret envelope is invalid');
  const decipher = createDecipheriv('aes-256-gcm', parseKey(keyMaterial), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
