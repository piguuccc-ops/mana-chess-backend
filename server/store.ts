// ─────────────────────────────────────────────────────────────────────────────
// The backend's memory on disk: accounts, their decks and friends, sessions, bans and the
// control panel's settings – one JSON file, written atomically (a temporary file renamed over
// the old one) a moment after each change, and at once when the server stops.
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RATING_FLOOR, RATING_START, type AccountRole, type DeckRecord, type RankedRecord, type RegistrationMode } from '../src/net/protocol';

export interface StoredUser {
  id: string;
  name: string;
  /** The name in lower case: names are unique regardless of case. */
  key: string;
  /** scrypt$N$r$p$salt$hash */
  pass: string;
  role: AccountRole;
  /** pending: registered, waiting for the admin's approval. */
  status: 'active' | 'pending';
  createdAt: number;
  lastLogin: number | null;
  decks: DeckRecord[];
  friends: string[];
  /** Users who asked this one to be friends / whom this one asked. */
  requestsIn: string[];
  requestsOut: string[];
  /** Wrong passwords in a row, and until when logging in is refused (fail2ban). */
  failed: number;
  lockedUntil: number;
  /** Élő-pontszám and the ranked results (matchmade games only). Data files from before ranked play get the defaults. */
  rating: number;
  ranked: RankedRecord;
}

const count = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);

/** A user record from the data file, with the fields added since it was written. */
export function upgradeUser(u: StoredUser): StoredUser {
  const raw = u as Partial<StoredUser>;
  u.rating = typeof raw.rating === 'number' && Number.isFinite(raw.rating) ? Math.max(RATING_FLOOR, Math.round(raw.rating)) : RATING_START;
  const r = (raw.ranked ?? {}) as Partial<RankedRecord>;
  u.ranked = { w: count(r.w), l: count(r.l), d: count(r.d) };
  return u;
}

export interface StoredSession {
  /** sha256 of the token – a copied data file does not hand out live sessions. */
  hash: string;
  userId: string;
  createdAt: number;
  lastUsed: number;
  ip: string;
}

export interface Ban {
  ip: string;
  until: number;
  reason: string;
}

export interface Settings {
  serverName: string;
  registration: RegistrationMode;
  /** Play without an account (LAN mode). */
  guests: boolean;
  /**
   * Behind a reverse proxy (Nginx Proxy Manager) the client's address comes in X-Real-IP /
   * X-Forwarded-For. auto: believe those headers only from local-network or loopback peers.
   */
  trustProxy: 'auto' | 'always' | 'never';
  /** Wrong passwords before an account's login is locked, and for how long (fail2ban). */
  maxFails: number;
  lockMinutes: number;
}

export interface StoreData {
  version: 1;
  settings: Settings;
  users: StoredUser[];
  sessions: StoredSession[];
  bans: Ban[];
}

export const DEFAULT_SETTINGS: Settings = {
  serverName: 'Mana Chess',
  registration: 'approval',
  guests: true,
  trustProxy: 'auto',
  maxFails: 5,
  lockMinutes: 10,
};

const empty = (): StoreData => ({ version: 1, settings: { ...DEFAULT_SETTINGS }, users: [], sessions: [], bans: [] });

/** The data file exists but cannot be read (permissions): the server must not start without it. */
export class DataFileUnreadable extends Error {
  readonly code = 'MANA_DATA_UNREADABLE';
  constructor(
    readonly file: string,
    cause: Error,
  ) {
    super(`Az adatfájl megvan, de nem olvasható: ${file} (${cause.message})`);
  }
}

export class Store {
  data: StoreData;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** `file` null: kept in memory only (tests). */
  constructor(
    readonly file: string | null,
    private readonly log: (msg: string) => void = () => {},
  ) {
    this.data = empty();
    if (file && existsSync(file)) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // gone in the meantime: a fresh start
        // there, but not ours to read (e.g. a backup put back as root): starting empty would
        // bury every account – refuse to start instead, and leave the file as it is
        throw new DataFileUnreadable(file, e as Error);
      }
      try {
        const raw = JSON.parse(text) as Partial<StoreData>;
        this.data = {
          version: 1,
          settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
          users: Array.isArray(raw.users) ? raw.users.filter((u) => u && typeof u === 'object').map(upgradeUser) : [],
          sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
          bans: Array.isArray(raw.bans) ? raw.bans : [],
        };
      } catch (e) {
        // never overwrite a file we could not read: keep it aside and start empty
        const aside = `${file}.broken-${Date.now()}`;
        try {
          renameSync(file, aside);
        } catch {
          /* ignore */
        }
        this.log(`Az adatfájl nem olvasható (${(e as Error).message}) – félretettem: ${aside}`);
      }
    }
  }

  /** Save a moment later (many changes in a row → one write). */
  changed(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 400);
    this.timer.unref?.();
  }

  /** Write now. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      // password and session hashes inside: readable by this server's user only
      writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) {
      this.log(`Nem sikerült menteni az adatokat: ${(e as Error).message}`);
    }
  }
}
