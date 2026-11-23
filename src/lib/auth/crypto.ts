/**
 * Password and token primitives.
 *
 * Node's own crypto, no dependencies. scrypt is memory-hard, which is the
 * property that matters against offline cracking of a stolen hash table.
 *
 * Nothing here logs, returns or formats a secret. Hashes are compared in
 * constant time; a mismatch in length is still compared so the timing does
 * not leak which failed.
 */
import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * OWASP's scrypt floor is N=2^17, r=8, p=1. maxmem has to be raised to match:
 * the default 32MB is below what N=131072 needs, and scrypt throws rather
 * than silently weakening.
 */
const PARAMS = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** `scrypt$N$r$p$salt$hash`, all base64url. Self-describing so params can move. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new Error("Password must be at least 12 characters.");
  }
  if (password.length > 1024) {
    // Bound the work an attacker can ask for with one request.
    throw new Error("Password must be at most 1024 characters.");
  }
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, PARAMS);
  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

/**
 * Constant-time verification.
 *
 * Returns false for a malformed or absent hash rather than throwing, so a
 * user who has never set a password behaves exactly like a wrong password.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }
  // Refuse absurd parameters from a tampered row rather than trying to honour
  // them: a huge N here is a denial-of-service against our own process.
  if (N > 1 << 20 || r > 32 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64url");
    expected = Buffer.from(parts[5], "base64url");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize("NFKC"), salt, expected.length, {
      N,
      r,
      p,
      maxmem: PARAMS.maxmem,
    });
  } catch {
    return false;
  }

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** A session or invite token. 32 bytes of CSPRNG output, URL-safe. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * What gets stored for a token.
 *
 * Tokens are high-entropy random values, so a plain SHA-256 is right here —
 * there is nothing to brute-force, and a slow KDF would just make every
 * request expensive. This is not password hashing and must not be reused as
 * such.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** Compare two token hashes without leaking position through timing. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
