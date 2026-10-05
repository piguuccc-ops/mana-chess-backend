// ─────────────────────────────────────────────────────────────────────────────
// Accounts on the backend: registering (closed / with the admin's approval / open), signing in
// with the built-in fail2ban, sessions, the decks kept on the server, friends and friend
// requests, challenges between friends, ranked play (matchmaking and the Élő-pontszám), each
// account's own event stream (long-polled like a room), presence, and the control panel's
// operations. No HTTP here – see index.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { timingSafeEqual } from 'node:crypto';
import type { SpellId } from '../src/engine';
import type { Color } from '../src/engine';
import {
  DECKS_MAX, eloAfter, PASSWORD_MAX, PASSWORD_MIN, RATING_START, USERNAME_MAX, USERNAME_MIN,
  type AccountEvent, type AccountRole, type ChallengeView, type ColorChoice, type DeckRecord, type FriendView, type LeaderRow, type MeView,
  type Ok, type Presence, type QueueView, type RatingChange, type RegistrationMode, type RoomState, type Seat, type UserBrief,
} from '../src/net/protocol';
import { cleanDeck, cleanText, Lobby, sameBuild, versionError, type Member, type RankedResult } from './lobby';
import { Matchmaker } from './ranked';
import { dummyHash, Guard, hashPassword, IP_MAX_FAILS, newId, newToken, setupCode, tokenHash, verifyPassword } from './security';
import { Store, type Settings, type StoredUser } from './store';

const DAY = 24 * 60 * 60_000;
/** A session unused for this long ends. */
const SESSION_IDLE_MS = 30 * DAY;
const SESSIONS_PER_USER = 10;
const CHALLENGE_MS = 5 * 60_000;
/** No account poll for this long: shown as offline. */
const ONLINE_GRACE_MS = 30_000;
const EVENTS_KEEP = 100;
const FRIENDS_MAX = 200;
const REQUESTS_MAX = 50;
const DECK_DESC_MAX = 200;
const LEADERBOARD_ROWS = 50;

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

/** Letters (any alphabet), digits, space, _ . - ; no spaces at the ends or twice. */
export function nameError(raw: string): string | null {
  const name = raw.normalize('NFC');
  if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) return `A név ${USERNAME_MIN}–${USERNAME_MAX} karakter legyen.`;
  if (!/^[\p{L}\p{N}_.\- ]+$/u.test(name)) return 'A névben csak betű, szám, szóköz és _ . - lehet.';
  if (name !== name.trim() || name.includes('  ')) return 'A név nem kezdődhet vagy végződhet szóközzel.';
  return null;
}
export function passwordError(pw: string): string | null {
  if (pw.length < PASSWORD_MIN) return `A jelszó legalább ${PASSWORD_MIN} karakter legyen.`;
  if (pw.length > PASSWORD_MAX) return 'Túl hosszú jelszó.';
  return null;
}
const keyOf = (name: string) => name.normalize('NFC').toLocaleLowerCase('hu');
/** Ranked games played. */
const gamesOf = (u: StoredUser) => u.ranked.w + u.ranked.l + u.ranked.d;

interface Stream {
  events: AccountEvent[];
  next: number;
  waiters: Set<() => void>;
  polls: number;
  lastSeen: number;
}

interface Challenge {
  id: string;
  from: string;
  to: string;
  deck: SpellId[];
  deckName: string;
  color: ColorChoice;
  autoEndTurn: boolean;
  /** Spell-toborzás: the decks are drafted at the start (`deck` is not used). */
  draft: boolean;
  createdAt: number;
  expiresAt: number;
}

/** A user as the control panel lists them. */
export interface AdminUser {
  id: string;
  name: string;
  role: AccountRole;
  status: 'active' | 'pending';
  createdAt: number;
  lastLogin: number | null;
  /** Seconds the login is still locked (fail2ban), 0 if not. */
  locked: number;
  failed: number;
  decks: number;
  friends: number;
  presence: Presence;
  sessions: number;
  /** Élő-pontszám and ranked games played. */
  rating: number;
  rankedGames: number;
}

export class Accounts {
  readonly guard: Guard;
  /** Players looking for a ranked game. */
  readonly matchmaker: Matchmaker;
  private streams = new Map<string, Stream>();
  private challenges = new Map<string, Challenge>();
  private announced = new Map<string, Presence>();
  /** While set, the control panel offers to create an admin with this code (shown in the server window). */
  setupCode: string | null = null;

  constructor(
    readonly store: Store,
    readonly lobby: Lobby,
    private readonly log: (msg: string) => void = () => {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.guard = new Guard(() => store.data.bans, () => store.changed(), now, log);
    this.matchmaker = new Matchmaker(now);
    if (!this.hasAdmin()) this.setupCode = setupCode();
    // a game of theirs opened, started, ended or closed: their lobby fetches the list again
    lobby.onMembersChanged = (ids) => ids.forEach((id) => this.push(id, { type: 'refresh' }));
    // a ranked game ended: the two ratings change
    lobby.onRankedOver = (r) => this.rateGame(r);
  }

  get settings(): Settings {
    return this.store.data.settings;
  }
  private get users(): StoredUser[] {
    return this.store.data.users;
  }
  private get lockMs(): number {
    return this.settings.lockMinutes * 60_000;
  }

  hasAdmin(): boolean {
    return this.users.some((u) => u.role === 'admin' && u.status === 'active');
  }
  /** A fresh setup code (the server was started with --setup: a way back in if the admin password is lost). */
  newSetupCode(): string {
    this.setupCode = setupCode();
    return this.setupCode;
  }

  byId(id: unknown): StoredUser | undefined {
    return typeof id === 'string' ? this.users.find((u) => u.id === id) : undefined;
  }
  byName(name: unknown): StoredUser | undefined {
    if (typeof name !== 'string') return undefined;
    const k = keyOf(name.trim());
    return this.users.find((u) => u.key === k);
  }
  private brief = (u: StoredUser): UserBrief => ({ id: u.id, name: u.name });
  private member = (u: StoredUser): Member => ({ id: u.id, name: u.name });

  // ── Registering and signing in ─────────────────────────────────────────────

  async register(body: unknown, ip: string): Promise<Ok<{ status: 'active' | 'pending'; token?: string; me?: MeView; last?: number }>> {
    const mode = this.settings.registration;
    if (mode === 'closed') return fail('A regisztráció ezen a szerveren zárva van – kérd meg az adminisztrátort, hogy hozzon létre neked fiókot.');
    const banned = this.guard.banned(ip);
    if (banned) return fail(`Túl sok hibás próbálkozás erről a címről – próbáld újra ${minutes(banned * 1000)} perc múlva.`);
    if (!isObj(body)) return fail('Érvénytelen kérés.');
    const name = str(body.name).normalize('NFC').trim();
    const password = str(body.password);
    const bad = nameError(name) ?? passwordError(password);
    if (bad) return fail(bad);
    if (this.byName(name)) return fail('Ez a név már foglalt.');
    const user = await this.addUser(name, password, 'user', mode === 'open' ? 'active' : 'pending');
    if (user.status === 'pending') {
      this.log(`Új regisztráció jóváhagyásra vár: ${user.name} (${ip})`);
      this.notifyAdmins(`${user.name} regisztrált – jóváhagyásra vár.`);
      return { ok: true, status: 'pending' };
    }
    this.log(`Új fiók: ${user.name} (${ip})`);
    return { ok: true, status: 'active', token: this.openSession(user, ip), me: this.me(user), last: this.lastEvent(user.id) };
  }

  async login(body: unknown, ip: string): Promise<Ok<{ token: string; me: MeView; last: number }>> {
    const banned = this.guard.banned(ip);
    if (banned) return fail(`Túl sok hibás próbálkozás erről a címről – próbáld újra ${minutes(banned * 1000)} perc múlva.`);
    if (!isObj(body)) return fail('Érvénytelen kérés.');
    const password = str(body.password).slice(0, PASSWORD_MAX + 1);
    const user = this.byName(body.name);
    const t = this.now();
    if (!user) {
      await verifyPassword(password, await dummyHash()); // the same work as for a real account
      this.guard.fail(ip, this.lockMs, 'hibás bejelentkezés');
      return fail('Hibás név vagy jelszó.');
    }
    if (user.lockedUntil > t) {
      return fail(`Túl sok hibás jelszó – ennek a fióknak a bejelentkezése zárolva van még ${minutes(user.lockedUntil - t)} percig.`);
    }
    if (!(await verifyPassword(password, user.pass))) {
      user.failed += 1;
      this.guard.fail(ip, this.lockMs, `hibás jelszó (${user.name})`);
      if (user.failed >= this.settings.maxFails) {
        user.failed = 0;
        user.lockedUntil = t + this.lockMs;
        this.log(`Fiók zárolva ${this.settings.lockMinutes} percre ${this.settings.maxFails} hibás jelszó után: ${user.name} (utoljára: ${ip})`);
        this.store.changed();
        return fail(`Túl sok hibás jelszó – ennek a fióknak a bejelentkezése ${this.settings.lockMinutes} percre zárolva.`);
      }
      this.store.changed();
      return fail('Hibás név vagy jelszó.');
    }
    if (user.status === 'pending') return fail('A fiókod még jóváhagyásra vár – az adminisztrátor engedélyezi.');
    user.failed = 0;
    user.lastLogin = t;
    this.guard.succeeded(ip);
    this.log(`Bejelentkezett: ${user.name} (${ip})`);
    return { ok: true, token: this.openSession(user, ip), me: this.me(user), last: this.lastEvent(user.id) };
  }

  /** The first admin, with the code from the server window. */
  async setup(body: unknown, ip: string): Promise<Ok<{ token: string; me: MeView; last: number }>> {
    if (!this.setupCode) return fail('A beállítás már megtörtént – jelentkezz be az adminisztrátori fiókkal.');
    const banned = this.guard.banned(ip);
    if (banned) return fail(`Túl sok hibás próbálkozás erről a címről – próbáld újra ${minutes(banned * 1000)} perc múlva.`);
    if (!isObj(body)) return fail('Érvénytelen kérés.');
    const code = str(body.code).trim().toUpperCase();
    const want = Buffer.from(this.setupCode);
    const got = Buffer.from(code);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      this.guard.fail(ip, this.lockMs, 'hibás beállítókód');
      return fail('Hibás beállítókód – a szerver ablakában látod.');
    }
    const name = str(body.name).normalize('NFC').trim();
    const password = str(body.password);
    const bad = nameError(name) ?? passwordError(password);
    if (bad) return fail(bad);
    const existing = this.byName(name);
    let user: StoredUser;
    if (existing) {
      // the admin password was lost: the code (a fresh one after --setup) makes this account an admin with a new password
      existing.pass = await hashPassword(password);
      existing.role = 'admin';
      existing.status = 'active';
      existing.lockedUntil = 0;
      existing.failed = 0;
      this.endSessions(existing.id, 'Új jelszót kaptál.');
      user = existing;
    } else user = await this.addUser(name, password, 'admin', 'active');
    user.lastLogin = this.now();
    this.setupCode = null;
    this.store.changed();
    this.log(`Adminisztrátor beállítva: ${user.name} (${ip})`);
    return { ok: true, token: this.openSession(user, ip), me: this.me(user), last: this.lastEvent(user.id) };
  }

  logout(token: unknown): Ok {
    if (typeof token !== 'string') return { ok: true };
    const h = tokenHash(token);
    const s = this.store.data.sessions;
    const i = s.findIndex((x) => x.hash === h);
    if (i >= 0) {
      s.splice(i, 1);
      this.store.changed();
    }
    return { ok: true };
  }

  /** The account behind a session token (null: signed out). */
  session(token: unknown): StoredUser | null {
    if (typeof token !== 'string' || token.length < 20) return null;
    const h = tokenHash(token);
    const s = this.store.data.sessions.find((x) => x.hash === h);
    if (!s) return null;
    const t = this.now();
    const user = this.byId(s.userId);
    if (!user || user.status !== 'active' || t - s.lastUsed > SESSION_IDLE_MS) {
      this.store.data.sessions = this.store.data.sessions.filter((x) => x !== s);
      this.store.changed();
      return null;
    }
    if (t - s.lastUsed > 60 * 60_000) {
      s.lastUsed = t;
      this.store.changed();
    }
    return user;
  }

  async changePassword(user: StoredUser, body: unknown, ip: string, token: string): Promise<Ok> {
    if (!isObj(body)) return fail('Érvénytelen kérés.');
    if (!(await verifyPassword(str(body.old), user.pass))) {
      this.guard.fail(ip, this.lockMs, `hibás régi jelszó (${user.name})`);
      return fail('A jelenlegi jelszó nem jó.');
    }
    const bad = passwordError(str(body.password));
    if (bad) return fail(bad);
    user.pass = await hashPassword(str(body.password));
    // other devices sign in again with the new password
    const keep = tokenHash(token);
    this.store.data.sessions = this.store.data.sessions.filter((s) => s.userId !== user.id || s.hash === keep);
    this.store.changed();
    this.log(`Jelszócsere: ${user.name}`);
    return { ok: true };
  }

  private async addUser(name: string, password: string, role: AccountRole, status: 'active' | 'pending'): Promise<StoredUser> {
    const user: StoredUser = {
      id: newId(),
      name,
      key: keyOf(name),
      pass: await hashPassword(password),
      role,
      status,
      createdAt: this.now(),
      lastLogin: null,
      decks: [],
      friends: [],
      requestsIn: [],
      requestsOut: [],
      failed: 0,
      lockedUntil: 0,
      rating: RATING_START,
      ranked: { w: 0, l: 0, d: 0 },
    };
    // a name may have been taken while the password was being hashed
    if (this.byName(name)) throw new Error('Ez a név már foglalt.');
    this.users.push(user);
    this.store.changed();
    return user;
  }

  private openSession(user: StoredUser, ip: string): string {
    const token = newToken();
    const t = this.now();
    const mine = this.store.data.sessions.filter((s) => s.userId === user.id).sort((a, b) => b.lastUsed - a.lastUsed);
    const drop = new Set(mine.slice(SESSIONS_PER_USER - 1));
    this.store.data.sessions = this.store.data.sessions.filter((s) => !drop.has(s));
    this.store.data.sessions.push({ hash: tokenHash(token), userId: user.id, createdAt: t, lastUsed: t, ip });
    this.store.changed();
    return token;
  }

  private endSessions(userId: string, reason: string): void {
    const before = this.store.data.sessions.length;
    this.store.data.sessions = this.store.data.sessions.filter((s) => s.userId !== userId);
    if (before !== this.store.data.sessions.length) this.store.changed();
    this.push(userId, { type: 'signedOut', reason });
  }

  // ── The profile ───────────────────────────────────────────────────────────

  presenceOf(userId: string): Presence {
    if (this.lobby.isPlaying(userId)) return 'playing';
    const s = this.streams.get(userId);
    return s && (s.polls > 0 || this.now() - s.lastSeen < ONLINE_GRACE_MS) ? 'online' : 'offline';
  }

  me(user: StoredUser): MeView {
    const order: Record<Presence, number> = { playing: 1, online: 0, offline: 2 };
    const friends: FriendView[] = user.friends
      .map((id) => this.byId(id))
      .filter((f): f is StoredUser => !!f)
      .map((f) => ({ ...this.brief(f), status: this.presenceOf(f.id), rating: f.rating }))
      .sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name, 'hu'));
    const people = (ids: string[]) => ids.map((id) => this.byId(id)).filter((u): u is StoredUser => !!u).map(this.brief);
    const challenges = [...this.challenges.values()];
    return {
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        createdAt: user.createdAt,
        rating: user.rating,
        ranked: { ...user.ranked },
        rank: this.rankOf(user),
      },
      decks: user.decks,
      friends,
      requestsIn: people(user.requestsIn),
      requestsOut: people(user.requestsOut),
      challengesIn: challenges.filter((c) => c.to === user.id).map(this.challengeView),
      challengesOut: challenges.filter((c) => c.from === user.id).map(this.challengeView),
      games: this.lobby.gamesOf(user.id),
    };
  }

  // ── Decks on the server ──────────────────────────────────────────────────

  saveDeck(user: StoredUser, body: unknown): Ok<{ deck: DeckRecord }> {
    if (!isObj(body) || !isObj(body.deck)) return fail('Érvénytelen pakli.');
    const d = body.deck;
    const id = str(d.id);
    if (!/^[A-Za-z0-9_-]{1,48}$/.test(id)) return fail('Érvénytelen pakliazonosító.');
    const spells = cleanDeck(d.spells);
    if (typeof spells === 'string') return fail(spells);
    const deck: DeckRecord = {
      id,
      name: cleanText(d.name, 32, 'Pakli'),
      description: cleanText(d.description, DECK_DESC_MAX, ''),
      spells,
      updatedAt: this.now(),
    };
    const i = user.decks.findIndex((x) => x.id === id);
    if (i >= 0) user.decks[i] = deck;
    else if (user.decks.length >= DECKS_MAX) return fail(`Legfeljebb ${DECKS_MAX} paklid lehet a szerveren.`);
    else user.decks.push(deck);
    this.store.changed();
    this.push(user.id, { type: 'refresh' });
    return { ok: true, deck };
  }

  deleteDeck(user: StoredUser, body: unknown): Ok {
    const id = isObj(body) ? str(body.id) : '';
    const before = user.decks.length;
    user.decks = user.decks.filter((d) => d.id !== id);
    if (user.decks.length === before) return fail('Nincs ilyen pakli.');
    this.store.changed();
    this.push(user.id, { type: 'refresh' });
    return { ok: true };
  }

  // ── Friends ──────────────────────────────────────────────────────────────

  search(user: StoredUser, body: unknown): Ok<{ users: (UserBrief & { relation: 'friend' | 'asked' | 'asking' | 'none' })[] }> {
    const q = keyOf(isObj(body) ? str(body.q).trim() : '');
    if (q.length < 2) return { ok: true, users: [] };
    const found = this.users
      .filter((u) => u.status === 'active' && u.id !== user.id && u.key.includes(q))
      .sort((a, b) => Number(!a.key.startsWith(q)) - Number(!b.key.startsWith(q)) || a.name.localeCompare(b.name, 'hu'))
      .slice(0, 10)
      .map((u) => ({
        ...this.brief(u),
        relation: user.friends.includes(u.id) ? ('friend' as const) : user.requestsOut.includes(u.id) ? ('asked' as const) : user.requestsIn.includes(u.id) ? ('asking' as const) : ('none' as const),
      }));
    return { ok: true, users: found };
  }

  request(user: StoredUser, body: unknown): Ok {
    const target = isObj(body) ? (this.byId(body.id) ?? this.byName(body.name)) : undefined;
    if (!target || target.status !== 'active') return fail('Nincs ilyen játékos.');
    if (target.id === user.id) return fail('Magadat nem jelölheted.');
    if (user.friends.includes(target.id)) return fail('Már barátok vagytok.');
    if (user.requestsOut.includes(target.id)) return { ok: true };
    // they already asked: that is a yes
    if (user.requestsIn.includes(target.id)) return this.accept(user, { id: target.id });
    if (user.requestsOut.length >= REQUESTS_MAX) return fail('Túl sok elküldött jelölésed vár válaszra.');
    if (target.requestsIn.length >= REQUESTS_MAX) return fail(`${target.name} most nem fogad több jelölést.`);
    user.requestsOut.push(target.id);
    target.requestsIn.push(user.id);
    this.store.changed();
    this.push(target.id, { type: 'refresh', notice: `${user.name} barátnak jelölt.` });
    this.push(user.id, { type: 'refresh' });
    return { ok: true };
  }

  accept(user: StoredUser, body: unknown): Ok {
    const other = isObj(body) ? this.byId(body.id) : undefined;
    if (!other || !user.requestsIn.includes(other.id)) return fail('Nincs ilyen jelölés.');
    if (user.friends.length >= FRIENDS_MAX || other.friends.length >= FRIENDS_MAX) return fail(`Legfeljebb ${FRIENDS_MAX} barátod lehet.`);
    this.unlinkRequests(user, other);
    user.friends.push(other.id);
    other.friends.push(user.id);
    this.store.changed();
    this.push(other.id, { type: 'refresh', notice: `${user.name} elfogadta a jelölésedet – mostantól barátok vagytok.` });
    this.push(user.id, { type: 'refresh' });
    return { ok: true };
  }

  decline(user: StoredUser, body: unknown): Ok {
    const other = isObj(body) ? this.byId(body.id) : undefined;
    if (!other || !user.requestsIn.includes(other.id)) return fail('Nincs ilyen jelölés.');
    this.unlinkRequests(user, other);
    this.store.changed();
    this.push(other.id, { type: 'refresh' });
    this.push(user.id, { type: 'refresh' });
    return { ok: true };
  }

  cancelRequest(user: StoredUser, body: unknown): Ok {
    const other = isObj(body) ? this.byId(body.id) : undefined;
    if (!other || !user.requestsOut.includes(other.id)) return fail('Nincs ilyen jelölés.');
    this.unlinkRequests(user, other);
    this.store.changed();
    this.push(other.id, { type: 'refresh' });
    this.push(user.id, { type: 'refresh' });
    return { ok: true };
  }

  unfriend(user: StoredUser, body: unknown): Ok {
    const other = isObj(body) ? this.byId(body.id) : undefined;
    if (!other || !user.friends.includes(other.id)) return fail('Nem vagytok barátok.');
    user.friends = user.friends.filter((id) => id !== other.id);
    other.friends = other.friends.filter((id) => id !== user.id);
    for (const c of [...this.challenges.values()]) if ((c.from === user.id && c.to === other.id) || (c.from === other.id && c.to === user.id)) this.challenges.delete(c.id);
    this.store.changed();
    this.push(other.id, { type: 'refresh' });
    this.push(user.id, { type: 'refresh' });
    return { ok: true };
  }

  private unlinkRequests(a: StoredUser, b: StoredUser): void {
    a.requestsIn = a.requestsIn.filter((id) => id !== b.id);
    a.requestsOut = a.requestsOut.filter((id) => id !== b.id);
    b.requestsIn = b.requestsIn.filter((id) => id !== a.id);
    b.requestsOut = b.requestsOut.filter((id) => id !== a.id);
  }

  // ── Challenges ───────────────────────────────────────────────────────────

  private challengeView = (c: Challenge): ChallengeView => ({
    id: c.id,
    from: this.brief(this.byId(c.from)!),
    to: this.brief(this.byId(c.to)!),
    color: c.color,
    autoEndTurn: c.autoEndTurn,
    draft: c.draft,
    deckName: c.deckName,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
  });

  challenge(user: StoredUser, body: unknown): Ok<{ challenge: ChallengeView }> {
    if (!isObj(body)) return fail('Érvénytelen kérés.');
    if (!sameBuild(body.build)) return fail(versionError(body.build));
    const friend = this.byId(body.to);
    if (!friend || !user.friends.includes(friend.id)) return fail('Csak a barátaidat hívhatod ki.');
    if (this.presenceOf(friend.id) === 'offline') return fail(`${friend.name} most nincs bejelentkezve.`);
    const draft = body.draft === true;
    const deck = draft ? [] : cleanDeck(body.deck);
    if (typeof deck === 'string') return fail(deck);
    // one standing challenge per friend: a new one replaces the old
    for (const c of [...this.challenges.values()]) if (c.from === user.id && c.to === friend.id) this.challenges.delete(c.id);
    if ([...this.challenges.values()].filter((c) => c.from === user.id).length >= 10) return fail('Túl sok kihívásod vár válaszra.');
    const t = this.now();
    const c: Challenge = {
      id: newId(),
      from: user.id,
      to: friend.id,
      deck,
      deckName: cleanText(body.deckName, 32, 'Pakli'),
      color: body.color === 'w' || body.color === 'b' ? body.color : 'random',
      autoEndTurn: body.autoEndTurn !== false,
      draft,
      createdAt: t,
      expiresAt: t + CHALLENGE_MS,
    };
    this.challenges.set(c.id, c);
    this.push(friend.id, { type: 'refresh', notice: `${user.name} kihívott egy ${draft ? 'spell-toborzásos ' : ''}játszmára!` });
    this.push(user.id, { type: 'refresh' });
    return { ok: true, challenge: this.challengeView(c) };
  }

  acceptChallenge(user: StoredUser, body: unknown): Ok<{ seat: Seat; state: RoomState }> {
    if (!isObj(body)) return fail('Érvénytelen kérés.');
    const c = this.challenges.get(str(body.id));
    if (!c || c.to !== user.id || c.expiresAt < this.now()) return fail('Ez a kihívás már nem érvényes.');
    if (!sameBuild(body.build)) return fail(versionError(body.build));
    const from = this.byId(c.from);
    if (!from) {
      this.challenges.delete(c.id);
      return fail('A kihívó már nincs a szerveren.');
    }
    const deck = c.draft ? [] : cleanDeck(body.deck);
    if (typeof deck === 'string') return fail(deck);
    this.challenges.delete(c.id);
    const r = this.lobby.direct(
      { member: this.member(from), deck: c.deck, deckName: c.deckName },
      { member: this.member(user), deck, deckName: cleanText(body.deckName, 32, 'Pakli') },
      c.color,
      c.autoEndTurn,
      c.draft,
    );
    this.push(from.id, { type: 'game', seat: r.host.seat, state: r.host.state });
    this.push(from.id, { type: 'refresh', notice: `${user.name} elfogadta a kihívást – indul a játszma!` });
    this.push(user.id, { type: 'refresh' });
    return { ok: true, seat: r.guest.seat, state: r.guest.state };
  }

  declineChallenge(user: StoredUser, body: unknown): Ok {
    const c = this.challenges.get(isObj(body) ? str(body.id) : '');
    if (!c || c.to !== user.id) return fail('Nincs ilyen kihívás.');
    this.challenges.delete(c.id);
    this.push(c.from, { type: 'refresh', notice: `${user.name} most nem fogadta el a kihívást.` });
    this.push(user.id, { type: 'refresh' });
    return { ok: true };
  }

  cancelChallenge(user: StoredUser, body: unknown): Ok {
    const c = this.challenges.get(isObj(body) ? str(body.id) : '');
    if (!c || c.from !== user.id) return fail('Nincs ilyen kihívás.');
    this.challenges.delete(c.id);
    this.push(c.to, { type: 'refresh' });
    this.push(user.id, { type: 'refresh' });
    return { ok: true };
  }

  // ── Ranked play ──────────────────────────────────────────────────────────

  /** Looks for an opponent (the answer's `queue` is null when one was found at once – the game comes on the stream). */
  rankedJoin(user: StoredUser, body: unknown): Ok<{ queue: QueueView | null }> {
    if (!isObj(body)) return fail('Érvénytelen kérés.');
    if (!sameBuild(body.build)) return fail(versionError(body.build));
    if (this.lobby.hasRunningGame(user.id)) return fail('Előbb fejezd be a futó játszmádat – a Játék fülön, a Folytatásnál éred el.');
    const deck = cleanDeck(body.deck);
    if (typeof deck === 'string') return fail(deck);
    const again = this.matchmaker.has(user.id);
    this.matchmaker.join(user.id, deck, cleanText(body.deckName, 32, 'Pakli'));
    if (!again) this.log(`Rangsorolt keresés: ${user.name} (${user.rating})`);
    this.matchmake();
    return { ok: true, queue: this.matchmaker.view(user.id) };
  }

  rankedLeave(user: StoredUser): Ok {
    if (this.matchmaker.leave(user.id)) this.log(`Rangsorolt keresés vége: ${user.name}`);
    return { ok: true };
  }

  /** The searching page asks every few seconds (that keeps its place); null: not in the queue (any more). */
  rankedStatus(user: StoredUser): Ok<{ queue: QueueView | null }> {
    this.matchmaker.seen(user.id);
    return { ok: true, queue: this.matchmaker.view(user.id) };
  }

  /** The best players (with at least one ranked game), and the asking player's own row. */
  leaderboard(user: StoredUser): Ok<{ rows: LeaderRow[]; me: LeaderRow | null; players: number }> {
    const ranked = this.users
      .filter((u) => u.status === 'active' && gamesOf(u) > 0)
      .sort((a, b) => b.rating - a.rating || gamesOf(b) - gamesOf(a) || a.name.localeCompare(b.name, 'hu'));
    const row = (u: StoredUser): LeaderRow => ({
      rank: 1 + ranked.filter((x) => x.rating > u.rating).length,
      name: u.name,
      rating: u.rating,
      games: gamesOf(u),
      ...u.ranked,
      ...(u.id === user.id ? { me: true } : {}),
    });
    const mine = ranked.find((u) => u.id === user.id);
    return { ok: true, rows: ranked.slice(0, LEADERBOARD_ROWS).map(row), me: mine ? row(mine) : null, players: ranked.length };
  }

  /** Place on the leaderboard (ties share a place); null before the first ranked game. */
  rankOf(user: StoredUser): number | null {
    if (!gamesOf(user)) return null;
    return 1 + this.users.filter((u) => u.status === 'active' && gamesOf(u) > 0 && u.rating > user.rating).length;
  }

  /** Pairs the players waiting in the queue and opens their rooms (on joining, and every few seconds). */
  private matchmake(): void {
    this.matchmaker.sweep();
    const pairs = this.matchmaker.pairs(
      (id) => this.byId(id)?.rating ?? RATING_START,
      (a, b) => !!this.byId(a.userId) && !!this.byId(b.userId) && !this.lobby.hasRunningGame(a.userId) && !this.lobby.hasRunningGame(b.userId),
    );
    for (const [a, b] of pairs) {
      const ua = this.byId(a.userId);
      const ub = this.byId(b.userId);
      if (!ua || !ub) continue;
      const r = this.lobby.direct(
        { member: this.member(ua), deck: a.deck, deckName: a.deckName },
        { member: this.member(ub), deck: b.deck, deckName: b.deckName },
        'random',
        true,
        false,
        { host: ua.rating, guest: ub.rating },
      );
      this.push(ua.id, { type: 'game', seat: r.host.seat, state: r.host.state, ranked: true });
      this.push(ub.id, { type: 'game', seat: r.guest.seat, state: r.guest.state, ranked: true });
    }
  }

  /** A ranked game is over: both ratings move (Elo; K = 40 for the first 30 games, then 20). */
  private rateGame(r: RankedResult): Record<Color, RatingChange> | null {
    const w = r.players.w ? this.byId(r.players.w) : undefined;
    const b = r.players.b ? this.byId(r.players.b) : undefined;
    if (!w || !b || w.id === b.id) return null;
    const score: 0 | 0.5 | 1 = r.winner === 'w' ? 1 : r.winner === 'b' ? 0 : 0.5;
    const before = { w: w.rating, b: b.rating };
    const after = { w: eloAfter(before.w, before.b, score, gamesOf(w)), b: eloAfter(before.b, before.w, (1 - score) as 0 | 0.5 | 1, gamesOf(b)) };
    w.rating = after.w;
    b.rating = after.b;
    if (r.winner === 'w') {
      w.ranked.w += 1;
      b.ranked.l += 1;
    } else if (r.winner === 'b') {
      b.ranked.w += 1;
      w.ranked.l += 1;
    } else {
      w.ranked.d += 1;
      b.ranked.d += 1;
    }
    this.store.changed();
    const sign = (n: number) => (n >= 0 ? `+${n}` : String(n));
    this.log(`Élő-pontszám (${r.code}): ${w.name} ${before.w} → ${after.w} (${sign(after.w - before.w)}), ${b.name} ${before.b} → ${after.b} (${sign(after.b - before.b)})`);
    return { w: { before: before.w, after: after.w }, b: { before: before.b, after: after.b } };
  }

  // ── Each account's event stream ──────────────────────────────────────────

  private stream(userId: string): Stream {
    let s = this.streams.get(userId);
    if (!s) {
      s = { events: [], next: 1, waiters: new Set(), polls: 0, lastSeen: 0 };
      this.streams.set(userId, s);
    }
    return s;
  }

  push(userId: string, e: DistributiveOmit<AccountEvent, 'id'>): void {
    const s = this.stream(userId);
    s.events.push({ ...e, id: s.next++ } as AccountEvent);
    if (s.events.length > EVENTS_KEEP) s.events.splice(0, s.events.length - EVENTS_KEEP);
    const w = [...s.waiters];
    s.waiters.clear();
    w.forEach((f) => f());
  }

  /** Events after `after`; a stream the page has lost track of (after > last) starts over with a refresh. */
  events(user: StoredUser, after: number): { events: AccountEvent[]; last: number } {
    const s = this.stream(user.id);
    s.lastSeen = this.now();
    const last = s.next - 1;
    if (after > last) return { events: [{ id: last, type: 'refresh' }], last };
    return { events: s.events.filter((e) => e.id > after), last };
  }

  /** Where an account's stream is now (a page starts listening from here). */
  lastEvent(userId: string): number {
    return this.stream(userId).next - 1;
  }

  wait(userId: string, wake: () => void): () => void {
    const s = this.stream(userId);
    s.waiters.add(wake);
    return () => s.waiters.delete(wake);
  }

  polling(userId: string, open: boolean): void {
    const s = this.stream(userId);
    s.polls = Math.max(0, s.polls + (open ? 1 : -1));
    s.lastSeen = this.now();
  }

  private notifyAdmins(notice: string): void {
    for (const u of this.users) if (u.role === 'admin' && u.status === 'active') this.push(u.id, { type: 'refresh', notice });
  }

  /** Every few seconds: presence changes reach the friends, old challenges expire, old bans end. */
  tick(): void {
    const t = this.now();
    for (const c of [...this.challenges.values()]) {
      if (c.expiresAt > t) continue;
      this.challenges.delete(c.id);
      this.push(c.from, { type: 'refresh', notice: `A kihívásod lejárt (${this.byId(c.to)?.name ?? '?'}).` });
      this.push(c.to, { type: 'refresh' });
    }
    for (const u of this.users) {
      const p = this.presenceOf(u.id);
      const before = this.announced.get(u.id) ?? 'offline';
      if (p === before) continue;
      this.announced.set(u.id, p);
      for (const f of u.friends) if (this.streams.has(f)) this.push(f, { type: 'presence', userId: u.id, status: p });
    }
    this.guard.sweep(this.lockMs);
    this.matchmake();
    // streams of deleted accounts, and ones nobody has polled for a day
    for (const [id, s] of this.streams) if (!s.polls && !s.waiters.size && (!this.byId(id) || t - s.lastSeen > DAY)) this.streams.delete(id);
  }

  // ── The control panel ────────────────────────────────────────────────────

  adminUsers(): AdminUser[] {
    const t = this.now();
    const sessions = this.store.data.sessions;
    return this.users
      .map((u) => ({
        id: u.id,
        name: u.name,
        role: u.role,
        status: u.status,
        createdAt: u.createdAt,
        lastLogin: u.lastLogin,
        locked: u.lockedUntil > t ? Math.ceil((u.lockedUntil - t) / 1000) : 0,
        failed: u.failed,
        decks: u.decks.length,
        friends: u.friends.length,
        presence: this.presenceOf(u.id),
        sessions: sessions.filter((s) => s.userId === u.id).length,
        rating: u.rating,
        rankedGames: gamesOf(u),
      }))
      .sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || a.name.localeCompare(b.name, 'hu'));
  }

  updateSettings(body: unknown): Ok<{ settings: Settings }> {
    if (!isObj(body)) return fail('Érvénytelen kérés.');
    const s = this.settings;
    if (body.registration !== undefined) {
      if (!['closed', 'approval', 'open'].includes(body.registration as string)) return fail('Érvénytelen regisztrációs mód.');
      s.registration = body.registration as RegistrationMode;
    }
    if (body.guests !== undefined) s.guests = body.guests === true;
    if (body.trustProxy !== undefined) {
      if (!['auto', 'always', 'never'].includes(body.trustProxy as string)) return fail('Érvénytelen proxybeállítás.');
      s.trustProxy = body.trustProxy as Settings['trustProxy'];
    }
    if (body.serverName !== undefined) s.serverName = cleanText(body.serverName, 40, 'Mana Chess');
    if (body.maxFails !== undefined) {
      const n = Number(body.maxFails);
      if (!Number.isInteger(n) || n < 3 || n > 20) return fail('A hibás jelszavak száma 3 és 20 között legyen.');
      s.maxFails = n;
    }
    if (body.lockMinutes !== undefined) {
      const n = Number(body.lockMinutes);
      if (!Number.isInteger(n) || n < 1 || n > 1440) return fail('A zárolás 1 és 1440 perc között legyen.');
      s.lockMinutes = n;
    }
    this.store.changed();
    const reg = { closed: 'zárva', approval: 'jóváhagyással', open: 'nyitott' }[s.registration];
    const proxy = { auto: 'automatikus', always: 'mindig', never: 'soha' }[s.trustProxy];
    this.log(`Beállítások módosítva: regisztráció ${reg}, vendégjáték ${s.guests ? 'be' : 'ki'}, proxy-fejlécek ${proxy}, ${s.maxFails} hibás jelszó → ${s.lockMinutes} perc zárolás`);
    return { ok: true, settings: s };
  }

  async adminCreate(body: unknown): Promise<Ok<{ user: AdminUser }>> {
    if (!isObj(body)) return fail('Érvénytelen kérés.');
    const name = str(body.name).normalize('NFC').trim();
    const password = str(body.password);
    const bad = nameError(name) ?? passwordError(password);
    if (bad) return fail(bad);
    if (this.byName(name)) return fail('Ez a név már foglalt.');
    const user = await this.addUser(name, password, body.role === 'admin' ? 'admin' : 'user', 'active');
    this.log(`Fiók létrehozva a vezérlőpulton: ${user.name}${user.role === 'admin' ? ' (admin)' : ''}`);
    return { ok: true, user: this.adminUsers().find((u) => u.id === user.id)! };
  }

  approve(body: unknown): Ok {
    const u = isObj(body) ? this.byId(body.id) : undefined;
    if (!u || u.status !== 'pending') return fail('Nincs ilyen függő regisztráció.');
    u.status = 'active';
    this.store.changed();
    this.log(`Jóváhagyva: ${u.name}`);
    return { ok: true };
  }

  /** Removes an account for good (a pending one is simply rejected). */
  remove(admin: StoredUser, body: unknown): Ok {
    const u = isObj(body) ? this.byId(body.id) : undefined;
    if (!u) return fail('Nincs ilyen felhasználó.');
    if (u.id === admin.id) return fail('A saját fiókodat innen nem törölheted.');
    if (u.role === 'admin' && this.users.filter((x) => x.role === 'admin' && x.status === 'active').length <= 1) return fail('Az utolsó adminisztrátort nem lehet törölni.');
    const touched: StoredUser[] = [];
    for (const o of this.users) {
      const linked = o.friends.includes(u.id) || o.requestsIn.includes(u.id) || o.requestsOut.includes(u.id);
      if (!linked) continue;
      o.friends = o.friends.filter((id) => id !== u.id);
      o.requestsIn = o.requestsIn.filter((id) => id !== u.id);
      o.requestsOut = o.requestsOut.filter((id) => id !== u.id);
      touched.push(o);
    }
    for (const c of [...this.challenges.values()]) {
      if (c.from !== u.id && c.to !== u.id) continue;
      this.challenges.delete(c.id);
      const other = this.byId(c.from === u.id ? c.to : c.from);
      if (other && !touched.includes(other)) touched.push(other);
    }
    this.lobby.removeMember(u.id);
    this.matchmaker.leave(u.id);
    this.store.data.users = this.users.filter((x) => x.id !== u.id);
    this.endSessions(u.id, 'A fiókodat törölték a szerverről.');
    for (const o of touched) this.push(o.id, { type: 'refresh' });
    this.store.changed();
    this.log(`${u.status === 'pending' ? 'Regisztráció elutasítva' : 'Fiók törölve'}: ${u.name}`);
    return { ok: true };
  }

  unlock(body: unknown): Ok {
    const u = isObj(body) ? this.byId(body.id) : undefined;
    if (!u) return fail('Nincs ilyen felhasználó.');
    u.lockedUntil = 0;
    u.failed = 0;
    this.store.changed();
    this.log(`Zárolás feloldva: ${u.name}`);
    return { ok: true };
  }

  async setPassword(body: unknown): Promise<Ok> {
    const u = isObj(body) ? this.byId(body.id) : undefined;
    if (!u) return fail('Nincs ilyen felhasználó.');
    const pw = isObj(body) ? str(body.password) : '';
    const bad = passwordError(pw);
    if (bad) return fail(bad);
    u.pass = await hashPassword(pw);
    u.lockedUntil = 0;
    u.failed = 0;
    this.endSessions(u.id, 'Az adminisztrátor új jelszót adott – jelentkezz be újra.');
    this.store.changed();
    this.log(`Új jelszó beállítva: ${u.name}`);
    return { ok: true };
  }

  setRole(admin: StoredUser, body: unknown): Ok {
    const u = isObj(body) ? this.byId(body.id) : undefined;
    if (!u) return fail('Nincs ilyen felhasználó.');
    const role: AccountRole = isObj(body) && body.role === 'admin' ? 'admin' : 'user';
    if (u.role === 'admin' && role === 'user') {
      if (u.id === admin.id) return fail('A saját adminjogodat nem veheted el.');
      if (this.users.filter((x) => x.role === 'admin' && x.status === 'active').length <= 1) return fail('Kell legalább egy adminisztrátor.');
    }
    u.role = role;
    this.store.changed();
    this.log(`${u.name} mostantól ${role === 'admin' ? 'adminisztrátor' : 'játékos'}.`);
    return { ok: true };
  }

  /** The control panel puts a player's Élő-pontszám back to the start (and clears the ranked results). */
  resetRating(body: unknown): Ok {
    const u = isObj(body) ? this.byId(body.id) : undefined;
    if (!u) return fail('Nincs ilyen felhasználó.');
    u.rating = RATING_START;
    u.ranked = { w: 0, l: 0, d: 0 };
    this.store.changed();
    this.push(u.id, { type: 'refresh' });
    this.log(`Élő-pontszám visszaállítva: ${u.name} (${RATING_START})`);
    return { ok: true };
  }

  signOutEverywhere(body: unknown): Ok {
    const u = isObj(body) ? this.byId(body.id) : undefined;
    if (!u) return fail('Nincs ilyen felhasználó.');
    this.endSessions(u.id, 'Az adminisztrátor kijelentkeztetett.');
    this.log(`Kijelentkeztetve minden eszközről: ${u.name}`);
    return { ok: true };
  }

  /** Numbers for the control panel's front page. */
  stats() {
    const online = this.users.filter((u) => this.presenceOf(u.id) !== 'offline').length;
    return {
      users: this.users.filter((u) => u.status === 'active').length,
      pending: this.users.filter((u) => u.status === 'pending').length,
      online,
      locked: this.users.filter((u) => u.lockedUntil > this.now()).length,
      bans: this.store.data.bans.filter((b) => b.until > this.now()).length,
      ipMaxFails: IP_MAX_FAILS,
      searching: this.matchmaker.size,
    };
  }
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
