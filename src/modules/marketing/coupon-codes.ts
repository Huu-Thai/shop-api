import { randomInt } from 'node:crypto';

/** Unambiguous alphabet (no 0/O, 1/I/L): codes are read aloud and typed from print. */
export const COUPON_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomCode(prefix: string, length: number): string {
  let s = prefix;
  for (let i = 0; i < length; i++)
    s += COUPON_ALPHABET[randomInt(COUPON_ALPHABET.length)];
  return s;
}
