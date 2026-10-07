import { createHash, randomBytes } from 'node:crypto';

/** `shk_<prefix8>_<secret43>`: the prefix identifies the row, the whole key is verified by hash. */
export const API_KEY_PATTERN = /^shk_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

export function generateApiKey(): {
  key: string;
  prefix: string;
  hash: string;
} {
  const prefix = randomBytes(6)
    .toString('base64url')
    .replace(/[-_]/g, 'x')
    .slice(0, 8);
  const key = `shk_${prefix}_${randomBytes(32).toString('base64url')}`;
  return { key, prefix, hash: sha256(key) };
}

export const sha256 = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');
