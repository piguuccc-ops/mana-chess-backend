// ─────────────────────────────────────────────────────────────────────────────
// The browser side of online play: finding the server, the lobby calls, and one seat's live
// connection (a long-poll loop that reconnects by itself). See protocol.ts for the messages.
// ─────────────────────────────────────────────────────────────────────────────
import {
  BUILD_ID, DEFAULT_PORT, POLL_WAIT_MS,
  type AccountEvent, type ActionRequest, type ColorChoice, type CreateRequest, type DeckRecord, type DrawAnswer, type JoinRequest, type MeView,
  type NetEvent, type Ok, type PollResponse, type RoomState, type RoomSummary, type Seat, type ServerInfo, type UserBrief,
} from './protocol';
import type { SpellId } from '../engine';

/** "192.168.1.23", "192.168.1.23:8787" or a full URL → the server's origin; null if unusable. */
export function normalizeServer(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const withScheme = hasScheme ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // a bare host gets the server's default port – a full URL or an explicit port is kept as it is
    const explicitPort = /^[^/?#]*:\d+/.test(withScheme.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''));
    if (!hasScheme && !explicitPort) u.port = String(DEFAULT_PORT);
    return u.origin;
  } catch {
    return null;
  }
}

/** What the address box shows for an origin (no scheme, no default http port). */
export const displayServer = (origin: string): string => origin.replace(/^http:\/\//, '');

export class NetError extends Error {}

async function call<T>(base: string, path: string, body?: unknown, timeoutMs = 8000, signal?: AbortSignal): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      // text/plain keeps the request "simple": no CORS preflight when the page comes from elsewhere
      headers: body === undefined ? undefined : { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: ctl.signal,
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new NetError(res.ok ? 'A szerver érthetetlen választ adott.' : `A szerver hibát jelzett (${res.status}).`);
    }
  } catch (e) {
    if (e instanceof NetError) throw e;
    throw new NetError(signal?.aborted ? 'Megszakítva.' : 'Nem érem el a szervert.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Why a server may be out of reach from this page (shown under the error). */
export function reachHint(base: string): string | null {
  if (typeof location === 'undefined') return null;
  if (location.protocol === 'https:' && base.startsWith('http:')) {
    return 'Ez a játékoldal https-en fut, ezért a böngésző csak https-es szerverhez enged kapcsolódni. Add meg a backend https:// címét (pl. Nginx Proxy Manager mögött), vagy nyisd meg a játékot http-n, illetve a mana-chess.html fájlból.';
  }
  return null;
}

export const serverInfo = async (base: string): Promise<ServerInfo> => {
  const info = await call<ServerInfo>(base, '/api/info', undefined, 5000);
  if (info?.app !== 'mana-chess') throw new NetError('Ezen a címen nem Mana Chess szerver fut.');
  return info;
};

/** A failed call; `auth: false` – the account session is gone (sign out). */
export type Answer<T = object> = ({ ok: true } & T) | { ok: false; error: string; stale?: boolean; auth?: false };

export const listRooms = (base: string) => call<Ok<{ rooms: RoomSummary[] }>>(base, '/api/rooms');
export const createRoom = (base: string, req: Omit<CreateRequest, 'build'>) =>
  call<Answer<{ seat: Seat; state: RoomState }>>(base, '/api/rooms', { ...req, build: BUILD_ID });
export const joinRoom = (base: string, code: string, req: Omit<JoinRequest, 'build'>) =>
  call<Answer<{ seat: Seat; state: RoomState }>>(base, `/api/rooms/${encodeURIComponent(code.toUpperCase())}/join`, { ...req, build: BUILD_ID });
export const roomState = (base: string, seat: Pick<Seat, 'code' | 'token'>) =>
  call<Ok<{ state: RoomState }>>(base, `/api/rooms/${encodeURIComponent(seat.code)}/state`, { token: seat.token });

// ── Seats remembered in this browser (to come back after a reload) ────────────

export interface SavedSeat extends Seat {
  server: string;
  opponent: string | null;
  at: number;
}
const SEATS_KEY = 'mana-chess.online.v1';

export function savedSeats(server: string): SavedSeat[] {
  try {
    const all = JSON.parse(localStorage.getItem(SEATS_KEY) ?? '[]') as SavedSeat[];
    return Array.isArray(all) ? all.filter((s) => s && s.server === server && Date.now() - s.at < 6 * 3600_000) : [];
  } catch {
    return [];
  }
}

function writeSeats(update: (seats: SavedSeat[]) => SavedSeat[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(SEATS_KEY) ?? '[]') as SavedSeat[];
    localStorage.setItem(SEATS_KEY, JSON.stringify(update(Array.isArray(all) ? all : []).slice(-8)));
  } catch {
    // storage unavailable: nothing to come back to after a reload
  }
}

export const rememberSeat = (seat: SavedSeat) => writeSeats((all) => [...all.filter((s) => !(s.server === seat.server && s.code === seat.code)), seat]);
export const forgetSeat = (server: string, code: string) => writeSeats((all) => all.filter((s) => !(s.server === server && s.code === code)));

// ── One seat's live connection ────────────────────────────────────────────────

export type Connection = 'online' | 'reconnecting' | 'lost';

/**
 * A player's seat in a room. `start()` begins polling; every event is kept (in order) and handed
 * to the listeners – a listener that joins late gets the events it missed.
 */
export class OnlineSession {
  readonly events: NetEvent[] = [];
  lastEvent: number;
  connection: Connection = 'online';
  private listeners = new Set<(e: NetEvent) => void>();
  private connListeners = new Set<(c: Connection) => void>();
  private running = false;
  private stopper = new AbortController();

  constructor(
    readonly server: string,
    readonly seat: Seat,
    initial: RoomState,
  ) {
    this.lastEvent = initial.lastEvent;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.stopper.abort();
    this.listeners.clear();
    this.connListeners.clear();
  }

  get stopped(): boolean {
    return !this.running;
  }

  /** Events after `fromId` (already received and future ones). Returns the unsubscribe function. */
  subscribe(fromId: number, fn: (e: NetEvent) => void): () => void {
    this.listeners.add(fn);
    const backlog = this.events.filter((e) => e.id > fromId);
    if (backlog.length) queueMicrotask(() => backlog.forEach((e) => this.listeners.has(fn) && fn(e)));
    return () => this.listeners.delete(fn);
  }

  onConnection(fn: (c: Connection) => void): () => void {
    this.connListeners.add(fn);
    return () => this.connListeners.delete(fn);
  }

  private setConnection(c: Connection): void {
    if (c === this.connection) return;
    this.connection = c;
    this.connListeners.forEach((fn) => fn(c));
  }

  private async loop(): Promise<void> {
    let delay = 500;
    let failures = 0;
    while (this.running) {
      try {
        const q = `/api/rooms/${this.seat.code}/poll`;
        const r = await call<Ok<PollResponse>>(this.server, q, { token: this.seat.token, after: this.lastEvent }, POLL_WAIT_MS + 15_000, this.stopper.signal);
        if (!this.running) return;
        if (!r.ok) {
          // the room is gone (the server restarted, or it was closed long ago)
          this.receive({ id: this.lastEvent + 1, type: 'closed', reason: r.error });
          this.setConnection('lost');
          this.running = false;
          return;
        }
        for (const e of r.events) this.receive(e);
        this.setConnection('online');
        delay = 500;
        failures = 0;
      } catch {
        if (!this.running) return;
        failures += 1;
        this.setConnection(failures > 20 ? 'lost' : 'reconnecting');
        await new Promise((ok) => setTimeout(ok, delay));
        delay = Math.min(delay * 2, 5000);
      }
    }
  }

  private receive(e: NetEvent): void {
    if (e.id <= this.lastEvent) return;
    this.lastEvent = e.id;
    this.events.push(e);
    this.listeners.forEach((fn) => fn(e));
  }

  private post<T>(verb: string, body: object): Promise<Ok<T>> {
    return call<Ok<T>>(this.server, `/api/rooms/${this.seat.code}/${verb}`, { ...body, token: this.seat.token });
  }

  act(req: Omit<ActionRequest, 'token'>): Promise<Ok<{ n: number }>> {
    return this.post('action', req);
  }
  draw(answer: DrawAnswer): Promise<Ok> {
    return this.post('draw', { answer });
  }
  rematch(): Promise<Ok> {
    return this.post('rematch', {});
  }
  leave(): Promise<Ok> {
    return this.post('leave', {});
  }
  state(): Promise<Ok<{ state: RoomState }>> {
    return roomState(this.server, this.seat);
  }
}

// ── Accounts ─────────────────────────────────────────────────────────────────

export type SessionStart = { token: string; me: MeView; last: number };

export const register = (base: string, name: string, password: string) =>
  call<Answer<{ status: 'active' | 'pending'; token?: string; me?: MeView; last?: number }>>(base, '/api/auth/register', { name, password }, 15_000);
export const login = (base: string, name: string, password: string) => call<Answer<SessionStart>>(base, '/api/auth/login', { name, password }, 15_000);

export type SearchHit = UserBrief & { relation: 'friend' | 'asked' | 'asking' | 'none' };

/** The calls a signed-in player makes (the session token rides in the body). */
export class AccountApi {
  constructor(
    readonly server: string,
    readonly token: string,
  ) {}

  private post<T>(path: string, body: object = {}, timeoutMs?: number): Promise<Answer<T>> {
    return call<Answer<T>>(this.server, path, { ...body, token: this.token }, timeoutMs);
  }

  me = () => this.post<{ me: MeView; last: number }>('/api/me');
  logout = () => this.post('/api/auth/logout');
  password = (old: string, password: string) => this.post('/api/me/password', { old, password }, 15_000);
  saveDeck = (deck: Pick<DeckRecord, 'id' | 'name' | 'description' | 'spells'>) => this.post<{ deck: DeckRecord }>('/api/decks/save', { deck });
  deleteDeck = (id: string) => this.post('/api/decks/delete', { id });
  search = (q: string) => this.post<{ users: SearchHit[] }>('/api/friends/search', { q });
  request = (id: string) => this.post('/api/friends/request', { id });
  accept = (id: string) => this.post('/api/friends/accept', { id });
  decline = (id: string) => this.post('/api/friends/decline', { id });
  cancelRequest = (id: string) => this.post('/api/friends/cancel', { id });
  unfriend = (id: string) => this.post('/api/friends/remove', { id });
  challenge = (to: string, deck: SpellId[], deckName: string, color: ColorChoice, autoEndTurn: boolean) =>
    this.post('/api/challenges/send', { to, deck, deckName, color, autoEndTurn, build: BUILD_ID });
  acceptChallenge = (id: string, deck: SpellId[], deckName: string) =>
    this.post<{ seat: Seat; state: RoomState }>('/api/challenges/accept', { id, deck, deckName, build: BUILD_ID });
  declineChallenge = (id: string) => this.post('/api/challenges/decline', { id });
  cancelChallenge = (id: string) => this.post('/api/challenges/cancel', { id });
}

/**
 * The signed-in player's own live stream (friend requests, challenges, friends coming and going).
 * Polls like a room; a session that is gone ends it with a `signedOut` event.
 */
export class AccountSession {
  lastEvent: number;
  connection: Connection = 'online';
  private listeners = new Set<(e: AccountEvent) => void>();
  private connListeners = new Set<(c: Connection) => void>();
  private running = false;
  private stopper = new AbortController();

  constructor(
    readonly server: string,
    readonly token: string,
    from: number,
  ) {
    this.lastEvent = from;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.stopper.abort();
    this.listeners.clear();
    this.connListeners.clear();
  }

  subscribe(fn: (e: AccountEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onConnection(fn: (c: Connection) => void): () => void {
    this.connListeners.add(fn);
    return () => this.connListeners.delete(fn);
  }

  private setConnection(c: Connection): void {
    if (c === this.connection) return;
    this.connection = c;
    this.connListeners.forEach((fn) => fn(c));
  }

  private emit(e: AccountEvent): void {
    this.listeners.forEach((fn) => fn(e));
  }

  private async loop(): Promise<void> {
    let delay = 1000;
    let failures = 0;
    while (this.running) {
      try {
        const r = await call<Answer<{ events: AccountEvent[]; last: number }>>(
          this.server,
          '/api/me/poll',
          { token: this.token, after: this.lastEvent },
          POLL_WAIT_MS + 15_000,
          this.stopper.signal,
        );
        if (!this.running) return;
        if (!r.ok) {
          if (r.auth === false) {
            this.running = false;
            this.emit({ id: this.lastEvent, type: 'signedOut', reason: r.error });
            return;
          }
          throw new NetError(r.error);
        }
        for (const e of r.events) {
          this.lastEvent = Math.max(this.lastEvent, e.id);
          this.emit(e);
        }
        if (r.last < this.lastEvent) this.lastEvent = r.last; // the server restarted: follow its numbering
        this.setConnection('online');
        delay = 1000;
        failures = 0;
      } catch {
        if (!this.running) return;
        failures += 1;
        this.setConnection(failures > 20 ? 'lost' : 'reconnecting');
        await new Promise((ok) => setTimeout(ok, delay));
        delay = Math.min(delay * 2, 8000);
      }
    }
  }
}

