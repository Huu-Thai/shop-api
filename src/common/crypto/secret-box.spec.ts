import { randomBytes } from 'node:crypto';
import { parseKey, SecretBox } from './secret-box.js';

describe('SecretBox', () => {
  const hexKey = randomBytes(32).toString('hex');

  it('round-trips with a fresh IV each time', () => {
    const box = new SecretBox(hexKey);
    const a = box.seal('sk_test_123');
    expect(a).toMatch(/^v1\./);
    expect(box.seal('sk_test_123')).not.toBe(a);
    expect(box.open(a)).toBe('sk_test_123');
  });

  it('accepts base64 keys and rejects wrong lengths', () => {
    const b64 = randomBytes(32).toString('base64');
    expect(parseKey(b64)).toHaveLength(32);
    expect(() => parseKey('abcd')).toThrow('32 bytes');
  });

  it('detects tampering, wrong keys and foreign formats', () => {
    const sealed = new SecretBox(hexKey).seal('secret');
    const [v, iv, tag, data] = sealed.split('.');
    const flipped = Buffer.from(data, 'base64url');
    flipped[0] ^= 1;
    expect(() =>
      new SecretBox(hexKey).open(
        [v, iv, tag, flipped.toString('base64url')].join('.'),
      ),
    ).toThrow();
    expect(() =>
      new SecretBox(randomBytes(32).toString('hex')).open(sealed),
    ).toThrow();
    expect(() => new SecretBox(hexKey).open('v0.a.b.c')).toThrow(
      'Unrecognised',
    );
  });
});
