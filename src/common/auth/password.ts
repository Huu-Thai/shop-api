import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

const scrypt = (pw: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(pw, salt, len, opts, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );

/**
 * OWASP-recommended scrypt cost (N=2^17, r=8, p=1 ≈ 128 MiB). PASSWORD_SCRYPT_N lowers it for
 * tests only (validated: production refuses anything below 2^17).
 */
export const PARAMS = {
  N: Number(process.env.PASSWORD_SCRYPT_N ?? 2 ** 17),
  r: 8,
  p: 1,
  keylen: 64,
};
const maxmem = (N: number, r: number) => 256 * N * r;

/** `scrypt$N$r$p$saltB64$hashB64` — self-describing, so cost can be raised later. */
export async function hashPassword(
  password: string,
  params = PARAMS,
): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: maxmem(params.N, params.r),
  });
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const N = Number(n);
  const key = await scrypt(
    password.normalize('NFKC'),
    Buffer.from(salt, 'base64'),
    expected.length,
    {
      N,
      r: Number(r),
      p: Number(p),
      maxmem: maxmem(N, Number(r)),
    },
  );
  return key.length === expected.length && timingSafeEqual(key, expected);
}

let dummy: Promise<string> | undefined;
/** Hash of a random password, verified against when the user does not exist (equal timing). */
export const dummyHash = (): Promise<string> =>
  (dummy ??= hashPassword(randomBytes(16).toString('hex')));

/** At least 12 chars, not all one character class, not trivially the e-mail. */
export function passwordProblems(password: string, email?: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push('must be at least 12 characters');
  if (password.length > 256) problems.push('must be at most 256 characters');
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) =>
    re.test(password),
  ).length;
  if (classes < 3)
    problems.push(
      'must mix at least 3 of: lower case, upper case, digits, symbols',
    );
  if (
    email &&
    password.toLowerCase().includes(email.split('@')[0].toLowerCase())
  )
    problems.push('must not contain your e-mail name');
  return problems;
}
