// ─────────────────────────────────────────────────────────────────────────────
// Passwords, session tokens, the client's real address behind a reverse proxy, and the
// built-in fail2ban: wrong passwords lock the account for a while, and an address that keeps
// guessing is banned from signing in.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Settings } from './store';

// ── Passwords (scrypt, a fresh salt each) ────────────────────────────────────

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

const scryptAsync = (password: string, salt: Buffer, n: number, r: number, p: number, len: number) =>
  new Promise<Buffer>((ok, fail) => scrypt(password, salt, len, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (e, key) => (e ? fail(e) : ok(key))));

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, N, R, P, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const want = Buffer.from(hash, 'base64');
  const got = await scryptAsync(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p), want.length);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Checked instead of a real hash when the name does not exist: same work, so no timing leak. */
let dummy: Promise<string> | null = null;
export const dummyHash = (): Promise<string> => (dummy ??= hashPassword(randomBytes(12).toString('hex')));

// ── Tokens ───────────────────────────────────────────────────────────────────

export const newToken = (): string => randomBytes(32).toString('base64url');
export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
export const newId = (): string => randomBytes(9).toString('base64url');

/** A one-time code for creating the first admin, shown in the server window. */
export function setupCode(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = randomBytes(8);
  const chars = [...b].map((x) => abc[x % abc.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

// ── The client's address ─────────────────────────────────────────────────────

const clean = (ip: string): string => ip.trim().replace(/^::ffff:/, '');

/** Loopback or a private network: where a reverse proxy (Nginx Proxy Manager) talks from. */
export function isLocalAddress(ip: string): boolean {
  const a = clean(ip);
  return (
    a === '::1' ||
    a.startsWith('127.') ||
    a.startsWith('10.') ||
    a.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a) ||
    /^f[cd][0-9a-f]{2}:/i.test(a) ||
    /^fe80:/i.test(a)
  );
}

/**
 * The address a request really comes from. A proxy in front (NPM) puts it in X-Real-IP, or last in
 * X-Forwarded-For; those headers are believed only when the setting says so ('auto': from a
 * local-network or loopback peer – anyone else could forge them).
 */
export function clientIp(req: IncomingMessage, trust: Settings['trustProxy']): string {
  const peer = clean(req.socket.remoteAddress ?? '');
  const believe = trust === 'always' || (trust === 'auto' && isLocalAddress(peer));
  if (!believe) return peer || 'unknown';
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return clean(real);
  const fwd = req.headers['x-forwarded-for'];
  const list = (Array.isArray(fwd) ? fwd.join(',') : fwd ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? clean(list[list.length - 1]) : peer || 'unknown';
}

// ── fail2ban for addresses ───────────────────────────────────────────────────

/** Wrong passwords from one address (to any accounts) before it is banned from signing in. */
export const IP_MAX_FAILS = 10;

interface Strikes {
  count: number;
  first: number;
}

/**
 * Counts failed sign-ins per address inside the lock window; too many → a ban (kept in the store,
 * so a restart does not lift it). Accounts are locked separately, on the user record.
 */
export class Guard {
  private strikes = new Map<string, Strikes>();

  constructor(
    private readonly bans: () => { ip: string; until: number; reason: string }[],
    private readonly saveBans: () => void,
    private readonly now: () => number = () => Date.now(),
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** Seconds left of a ban on this address, or 0. */
  banned(ip: string): number {
    const b = this.bans().find((x) => x.ip === ip);
    if (!b) return 0;
    const left = b.until - this.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  /** A wrong password (or setup code) from this address. Returns true when it got banned now. */
  fail(ip: string, windowMs: number, why: string): boolean {
    const t = this.now();
    const s = this.strikes.get(ip);
    const cur = s && t - s.first < windowMs ? { count: s.count + 1, first: s.first } : { count: 1, first: t };
    this.strikes.set(ip, cur);
    if (cur.count < IP_MAX_FAILS) return false;
    this.strikes.delete(ip);
    const list = this.bans();
    const rest = list.filter((b) => b.ip !== ip);
    list.length = 0;
    list.push(...rest, { ip, until: t + windowMs, reason: why });
    this.saveBans();
    this.log(`Kitiltva ${Math.round(windowMs / 60000)} percre: ${ip} (${why})`);
    return true;
  }

  succeeded(ip: string): void {
    this.strikes.delete(ip);
  }

  unban(ip: string): boolean {
    const list = this.bans();
    const i = list.findIndex((b) => b.ip === ip);
    if (i < 0) return false;
    list.splice(i, 1);
    this.strikes.delete(ip);
    this.saveBans();
    return true;
  }

  /** Forget old strikes and ended bans. */
  sweep(windowMs: number): void {
    const t = this.now();
    for (const [ip, s] of this.strikes) if (t - s.first > windowMs) this.strikes.delete(ip);
    const list = this.bans();
    const live = list.filter((b) => b.until > t);
    if (live.length !== list.length) {
      list.length = 0;
      list.push(...live);
      this.saveBans();
    }
  }
}

// ── Plain rate limits (requests per address) ─────────────────────────────────

export class RateLimit {
  private hits = new Map<string, { n: number; start: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** true: allowed (and counted). */
  take(key: string): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || t - h.start >= this.windowMs) {
      this.hits.set(key, { n: 1, start: t });
      return true;
    }
    if (h.n >= this.max) return false;
    h.n += 1;
    return true;
  }

  sweep(): void {
    const t = this.now();
    for (const [k, h] of this.hits) if (t - h.start >= this.windowMs) this.hits.delete(k);
  }
}
