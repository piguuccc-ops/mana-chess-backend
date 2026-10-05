// ─────────────────────────────────────────────────────────────────────────────
// Online play: what the server and the browsers say to each other.
//
// The engine is deterministic – a setup (decks, seed, options) plus the list of actions always
// yields the same game – so a match only has to agree on the setup and then exchange actions:
//
//   player A ──MOVE/CAST/…──▶ server (checks it with applyAction) ──▶ both players
//
// The server is authoritative: it runs the engine itself, accepts an action only from the player
// whose turn it is, numbers the accepted actions (n = 0, 1, 2 …) and sends them to both sides.
// Every accepted action carries a hash of the resulting position; a client that has somehow got
// out of step notices it and replays the whole game from the server's list.
//
// Transport: plain HTTP + JSON with long polling. It needs no library on either side, gets
// through routers, proxies and virus scanners, and a page opened straight from a file can use it.
// ─────────────────────────────────────────────────────────────────────────────
import { applyAction, createGame } from '../engine';
import type { Action, Color, Draft, GameState, SpellId } from '../engine';

declare const __BUILD_ID__: string | undefined;
/** Identifies the rules: server and page must run the same engine (set at build time). */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

/** The backend's port (players), and the control panel's (the server's own machine – or a private network such as Tailscale). */
export const DEFAULT_PORT = 5454;
export const ADMIN_PORT = 5555;
export const NAME_MAX = 20;
export const DECK_NAME_MAX = 32;
/** How long the server keeps a poll open when nothing happens (ms). */
export const POLL_WAIT_MS = 25_000;

export type Role = 'host' | 'guest';
export type ColorChoice = Color | 'random';

/** Everything both sides need to create the same game. */
export interface Setup {
  decks: Record<Color, SpellId[]>;
  deckNames: Record<Color, string>;
  names: Record<Color, string>;
  seed: number;
  autoEndTurn: boolean;
}

export const setupGame = (s: Setup): GameState =>
  createGame({ decks: s.decks, deckNames: s.deckNames, seed: s.seed, autoEndTurn: s.autoEndTurn });

/** The game after `actions` (throws if one of them is not legal – a desync or a version mismatch). */
export function replay(setup: Setup, actions: Action[]): GameState {
  let g = setupGame(setup);
  actions.forEach((a, i) => {
    const r = applyAction(g, a);
    if (!r.ok) throw new Error(`A(z) ${i + 1}. lépés nem játszható le: ${r.error}`);
    g = r.state;
  });
  return g;
}

/** A short fingerprint of everything that decides how the game goes on (FNV-1a, 32 bit). */
export function stateHash(s: GameState): string {
  const key = JSON.stringify([
    s.board.map((p) => (p ? `${p.id}${p.color}${p.type}${p.hasMoved ? 1 : 0}${p.clone ? 'c' : ''}` : 0)),
    s.turn,
    s.turnIndex,
    s.status,
    s.pendingPromotion,
    s.ep,
    s.halfmoveClock,
    s.rng,
    s.nextId,
    s.turnState,
    (['w', 'b'] as const).map((c) => [s.players[c].mana, s.players[c].deck, s.players[c].charges]),
    s.effects.map((e) => [e.kind, e.owner, e.pieceId ?? '', e.color ?? '', e.squares ?? [], e.expiresAfterTurn, e.value ?? '']),
    s.erased.map((p) => p.id),
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The colour of a role in a game where the host plays `hostColor`. */
export const colorOf = (role: Role, hostColor: Color): Color => (role === 'host' ? hostColor : hostColor === 'w' ? 'b' : 'w');

// ── Messages ─────────────────────────────────────────────────────────────────

/** Who may make an account: nobody, anyone after the admin approves them, or anyone at once. */
export type RegistrationMode = 'closed' | 'approval' | 'open';

export interface ServerInfo {
  app: 'mana-chess';
  build: string;
  /** The name set in the control panel. */
  name: string;
  registration: RegistrationMode;
  /** Playing without an account (LAN mode, decks stay in the browser) is allowed. */
  guests: boolean;
  /** Addresses the server listens on (for sharing with friends on the same network). */
  addresses: string[];
  rooms: number;
}

export interface RoomSummary {
  code: string;
  host: string;
  /** The host plays without an account. */
  guest: boolean;
  hostColor: ColorChoice;
  autoEndTurn: boolean;
  /** Spell-toborzás: the decks are drafted from a table of 32 spells once both are in. */
  draft: boolean;
  /** Seconds since the room was opened. */
  age: number;
}

export interface CreateRequest {
  /** A guest's name (a signed-in player plays under the account's name). */
  name: string;
  deck: SpellId[];
  deckName: string;
  color: ColorChoice;
  autoEndTurn: boolean;
  /** Spell-toborzás instead of the players' own decks (then `deck` is not used). */
  draft?: boolean;
  build: string;
  /** Account session, when signed in. */
  auth?: string;
}

export interface JoinRequest {
  name: string;
  deck: SpellId[];
  deckName: string;
  build: string;
  auth?: string;
}

/** A seat in a room: the token proves who is speaking. */
export interface Seat {
  code: string;
  token: string;
  role: Role;
}

/** The whole room as one player sees it (joining, coming back, or recovering from a desync). */
export interface RoomState {
  code: string;
  role: Role;
  names: Record<Role, string | null>;
  /** 0 = waiting for the second player. */
  game: number;
  /** Spell-toborzás room: every game starts with a draft. */
  draftMode: boolean;
  /** The draft of game `game` while it lasts (then `setup` takes over). */
  draft: Draft | null;
  setup: Setup | null;
  hostColor: Color | null;
  actions: Action[];
  drawOffer: Color | null;
  rematch: Role[];
  online: Record<Role, boolean>;
  closed: string | null;
  /** Id of the last event so far: poll from here. */
  lastEvent: number;
  /** A ranked (matchmade) game: both players' Élő-pontszám at its start. Null: a friendly game. */
  ranked: Record<Role, number> | null;
  /** A ranked game that has ended: the new ratings. */
  rated: Record<Color, RatingChange> | null;
  /** A ranked game lost on the clock or by being away. */
  forfeit: { by: Color; reason: ForfeitReason } | null;
  /** A ranked game in progress: what is left of the current turn (ms). */
  turnLeftMs: number | null;
}

export type NetEvent =
  | { id: number; type: 'draft'; game: number; draft: Draft; hostColor: Color; names: Record<Color, string> }
  | { id: number; type: 'pick'; game: number; by: Color; spell: SpellId }
  | { id: number; type: 'start'; game: number; setup: Setup; hostColor: Color }
  | { id: number; type: 'action'; game: number; n: number; action: Action; by: Color; hash: string; nonce?: string }
  | { id: number; type: 'drawOffer'; game: number; by: Color }
  | { id: number; type: 'drawDeclined'; game: number; by: Color }
  | { id: number; type: 'rematch'; game: number; by: Role }
  | { id: number; type: 'presence'; role: Role; online: boolean }
  | { id: number; type: 'left'; role: Role; name: string }
  | { id: number; type: 'closed'; reason: string }
  /** A ranked game is over: the new ratings (sent right after the last action). */
  | { id: number; type: 'rated'; game: number; changes: Record<Color, RatingChange> }
  /** A ranked game is lost for running out of time on a turn, or for being away too long (a RESIGN follows). */
  | { id: number; type: 'forfeit'; game: number; by: Color; reason: ForfeitReason };

export interface PollResponse {
  events: NetEvent[];
}

export interface ActionRequest {
  token: string;
  game: number;
  /** The index this action gets if accepted (= number of actions so far). */
  n: number;
  action: Action;
  /** Lets the sender recognise its own action in the stream. */
  nonce: string;
}

export type DrawAnswer = 'offer' | 'accept' | 'decline';

/** Spell-toborzás: taking one spell from the table. */
export interface PickRequest {
  token: string;
  game: number;
  spell: SpellId;
}

export type Ok<T = object> = ({ ok: true } & T) | { ok: false; error: string; stale?: boolean };

// ── Accounts ─────────────────────────────────────────────────────────────────

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 128;
export const DECKS_MAX = 30;

export type AccountRole = 'user' | 'admin';
export type Presence = 'online' | 'playing' | 'offline';

export interface UserBrief {
  id: string;
  name: string;
}

export interface FriendView extends UserBrief {
  status: Presence;
  /** Élő-pontszám (ranked games only). */
  rating: number;
}

/** A deck kept on the server for an account. */
export interface DeckRecord {
  id: string;
  name: string;
  description: string;
  spells: SpellId[];
  updatedAt: number;
}

/** A friend asked another friend for a game. */
export interface ChallengeView {
  id: string;
  from: UserBrief;
  to: UserBrief;
  /** The colour the challenger asked for. */
  color: ColorChoice;
  autoEndTurn: boolean;
  /** Spell-toborzás: the decks are drafted at the start. */
  draft: boolean;
  deckName: string;
  createdAt: number;
  expiresAt: number;
}

/** A room this account has a seat in (so a game can be continued from any device). */
export interface MyGame {
  code: string;
  token: string;
  role: Role;
  opponent: string | null;
  game: number;
  /** The game is being played or drafted (not waiting, not over). */
  running: boolean;
  /** A ranked (matchmade) game. */
  ranked: boolean;
}

/** Everything the lobby shows about the signed-in player. */
export interface MeView {
  user: {
    id: string;
    name: string;
    role: AccountRole;
    createdAt: number;
    /** Élő-pontszám: changes only in ranked (matchmade) games. */
    rating: number;
    /** Ranked results so far. */
    ranked: RankedRecord;
    /** Place on the server's leaderboard (null: no ranked game yet). */
    rank: number | null;
  };
  decks: DeckRecord[];
  friends: FriendView[];
  requestsIn: UserBrief[];
  requestsOut: UserBrief[];
  challengesIn: ChallengeView[];
  challengesOut: ChallengeView[];
  games: MyGame[];
}

/**
 * The signed-in player's own stream (long-polled like a room): `refresh` – something in the
 * profile changed, fetch it again (with a note to show, e.g. „X kihívott”); `presence` – a friend
 * came, went or sat down to play; `game` – a challenge was accepted, or matchmaking found an
 * opponent (`ranked`), here is the seat; `signedOut` – the session ended (logged out elsewhere,
 * account removed).
 */
export type AccountEvent =
  | { id: number; type: 'refresh'; notice?: string }
  | { id: number; type: 'presence'; userId: string; status: Presence }
  | { id: number; type: 'game'; seat: Seat; state: RoomState; ranked?: boolean }
  | { id: number; type: 'signedOut'; reason: string };

// ── Ranked play (skill-based matchmaking) ─────────────────────────────────────
//
// Every account has an Élő-pontszám (Elo rating). Only ranked games change it: two players who
// asked for an opponent are paired by the server, closest ratings first. Games against friends,
// in rooms or against the bots never touch it.

/** Everyone starts here, and nobody falls below the floor. */
export const RATING_START = 1000;
export const RATING_FLOOR = 100;
/** The first games move the rating faster (K = 40, then K = 20), so a new player soon finds their level. */
export const PROVISIONAL_GAMES = 30;
/** Ranked games: the player to move loses after this long on one turn (spells included)… */
export const RANKED_TURN_MS = 180_000;
/** …and a player whose page has lost the server for this long loses. */
export const RANKED_AWAY_MS = 60_000;
/** Matchmaking: the rating range searched widens while a player waits, and after a minute anyone will do. */
export const QUEUE_RANGE_START = 100;
export const QUEUE_RANGE_STEP = 50;
export const QUEUE_RANGE_EVERY_MS = 5000;
export const QUEUE_ANYONE_AFTER_MS = 60_000;

export type ForfeitReason = 'time' | 'away';

export interface RankedRecord {
  w: number;
  l: number;
  d: number;
}

export interface RatingChange {
  before: number;
  after: number;
}

/** The matchmaking queue as a waiting player sees it. */
export interface QueueView {
  /** Seconds in the queue so far. */
  waited: number;
  /** ± this many points are searched now; null: anyone. */
  range: number | null;
  /** Players searching right now (this one included). */
  searching: number;
}

export interface LeaderRow {
  rank: number;
  name: string;
  rating: number;
  games: number;
  w: number;
  l: number;
  d: number;
  /** The signed-in player's own row. */
  me?: boolean;
}

/** The range searched after waiting `ms` (null: anyone). */
export function queueRange(ms: number): number | null {
  if (ms >= QUEUE_ANYONE_AFTER_MS) return null;
  return QUEUE_RANGE_START + QUEUE_RANGE_STEP * Math.floor(Math.max(0, ms) / QUEUE_RANGE_EVERY_MS);
}

/** The expected score of a player rated `a` against one rated `b` (0…1). */
export const eloExpected = (a: number, b: number): number => 1 / (1 + Math.pow(10, (b - a) / 400));

/** The rating after one game: `score` 1 win, ½ draw, 0 loss; `games` = ranked games played before it. */
export function eloAfter(rating: number, opponent: number, score: 0 | 0.5 | 1, games: number): number {
  const k = games < PROVISIONAL_GAMES ? 40 : 20;
  return Math.max(RATING_FLOOR, Math.round(rating + k * (score - eloExpected(rating, opponent))));
}
