// Mod (istemci) kimlik dogrulamasi. Saf fonksiyonlar test edilebilir (tests/modauth.test.ts).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Oturum acilinca moda verilir. Sunucu token'in sadece sha256'sini saklar. */
export function newSessionSecrets() {
  const token = randomBytes(32).toString('base64url');
  const hmacSecret = randomBytes(32).toString('base64url');
  return { token, tokenHash: sha256(token), hmacSecret };
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Istek imzasi: X-AS-Signature = hex(HMAC_SHA256(hmacSecret, ham_govde)).
 * Govde artan "seq" icerir; ayni govde tekrar gonderilse bile sunucu seq ile reddeder.
 */
export function sign(hmacSecret: string, rawBody: string): string {
  return createHmac('sha256', hmacSecret).update(rawBody).digest('hex');
}

export function verifySignature(hmacSecret: string, rawBody: string, signature: string | null): boolean {
  if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(sign(hmacSecret, rawBody), 'hex');
  const got = Buffer.from(signature, 'hex');
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/** Gunluk erisim kodu adayi: karisabilecek karakterler (0/O, 1/I) yok. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newDailyCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out.slice(0, 4) + '-' + out.slice(4);
}

/** Mojang "hasJoined" icin tek kullanimlik sunucu kimligi. */
export function newServerId(): string {
  return randomBytes(10).toString('hex');
}

/** Mojang UUID'si (tiresiz) -> standart UUID */
export function dashUuid(id: string): string {
  const h = id.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) throw new Error('Gecersiz UUID');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
