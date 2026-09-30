// ─────────────────────────────────────────────────────────────────────────────
// The online server's rooms and authoritative games – no HTTP here (see index.ts), so the whole
// flow can be tested directly.
//
// A room has two seats (host and guest). When the guest sits down the game starts; the server
// keeps the real game state, accepts an action only from the player whose turn it is and puts
// every accepted action into the room's event stream, which both players poll.
// In a Spell-toborzás room every game begins with a draft: the two take spells from a table of 32
// in turn (the server checks every pick), and the game starts with the drafted decks.
// ─────────────────────────────────────────────────────────────────────────────
import { randomInt, randomUUID } from 'node:crypto';
import { applyAction, applyPick, draftDone, newDraft, opposite, pickBlockReason, SPELLS, validateDeck } from '../src/engine';
import type { Action, Color, Draft, GameState, PromotionPiece, SpellId } from '../src/engine';
import {
  BUILD_ID, colorOf, DECK_NAME_MAX, NAME_MAX, setupGame, stateHash,
  type ColorChoice, type DrawAnswer, type MyGame, type NetEvent, type Ok, type Role, type RoomState, type RoomSummary, type Seat, type Setup,
} from '../src/net/protocol';

/** A signed-in player (rooms show the account's name and keep the seat with the account). */
export interface Member {
  id: string;
  name: string;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I and O: codes are read aloud
const MAX_ROOMS = 300;
/** A room nobody has touched for this long is closed. */
const IDLE_ROOM_MS = 3 * 60 * 60_000;
/** An open room whose host has not been polling for this long disappears from the list. */
const HOST_GONE_MS = 90_000;
/** A closed room is kept this long, so both players can still read how it ended. */
const CLOSED_KEEP_MS = 10 * 60_000;
/** No poll for this long (and none open): shown as disconnected. */
export const OFFLINE_AFTER_MS = 10_000;

interface Player {
  name: string;
  /** The account behind the seat (null: a guest, LAN mode). */
  userId: string | null;
  token: string;
  deck: SpellId[];
  deckName: string;
  lastSeen: number;
  /** Polls being held open right now. */
  polls: number;
  online: boolean;
}

interface Room {
  code: string;
  createdAt: number;
  touchedAt: number;
  hostChoice: ColorChoice;
  autoEndTurn: boolean;
  /** Spell-toborzás: every game begins with a draft. */
  draftMode: boolean;
  /** The running draft (between the two players sitting down and the game starting). */
  draft: Draft | null;
  players: Record<Role, Player | null>;
  game: number;
  setup: Setup | null;
  hostColor: Color | null;
  state: GameState | null;
  actions: Action[];
  drawOffer: Color | null;
  rematch: Set<Role>;
  events: NetEvent[];
  nextEvent: number;
  closed: string | null;
  closedAt: number;
  waiters: Set<() => void>;
}

type LogFn = (msg: string) => void;

const fail = (error: string, extra: { stale?: boolean } = {}): { ok: false; error: string; stale?: boolean } => ({ ok: false, error, ...extra });

// ── Input hygiene: everything from the network is untrusted ──────────────────
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isSquare = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 64;
const PROMOTIONS = ['Q', 'R', 'B', 'N'];
const hasSpell = (id: unknown): id is SpellId => typeof id === 'string' && Object.prototype.hasOwnProperty.call(SPELLS, id);

export function cleanText(v: unknown, max: number, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || fallback;
}

export function cleanDeck(v: unknown): SpellId[] | string {
  if (!Array.isArray(v) || v.length > 12 || !v.every(hasSpell)) return 'Érvénytelen pakli.';
  const deck = v as SpellId[];
  return validateDeck(deck) ?? deck;
}

/** A well-formed engine action built only from the fields each type has. */
function cleanAction(v: unknown, me: Color): Action | string {
  if (!isObj(v)) return 'Érvénytelen akció.';
  switch (v.type) {
    case 'MOVE':
      if (!isSquare(v.from) || !isSquare(v.to)) return 'Érvénytelen lépés.';
      if (v.promotion !== undefined && !PROMOTIONS.includes(v.promotion as string)) return 'Érvénytelen átváltozás.';
      return { type: 'MOVE', from: v.from, to: v.to, ...(v.promotion ? { promotion: v.promotion as PromotionPiece } : {}) };
    case 'CAST':
      if (!hasSpell(v.spellId) || !Array.isArray(v.targets) || v.targets.length > 8 || !v.targets.every(isSquare)) return 'Érvénytelen varázslat.';
      return { type: 'CAST', spellId: v.spellId, targets: [...v.targets] };
    case 'PROMOTE':
      if (!PROMOTIONS.includes(v.piece as string)) return 'Érvénytelen átváltozás.';
      return { type: 'PROMOTE', piece: v.piece as PromotionPiece };
    case 'END_TURN':
      return { type: 'END_TURN' };
    case 'RESIGN':
      return { type: 'RESIGN', color: me };
    default:
      return 'Ismeretlen akció.';
  }
}

/** Whose move it is: only that player may send this action. */
function actor(state: GameState, a: Action): Color | 'anyone' {
  if (a.type === 'RESIGN') return 'anyone';
  if (a.type === 'PROMOTE') return state.pendingPromotion?.color ?? state.turn;
  return state.turn;
}

export class Lobby {
  readonly rooms = new Map<string, Room>();
  /** Accounts whose list of games changed (a room of theirs opened, started, ended or closed). */
  onMembersChanged: (userIds: string[]) => void = () => {};

  constructor(
    private readonly log: LogFn = () => {},
    private readonly now: () => number = () => Date.now(),
    /** Whether players without an account may open or join rooms (the control panel decides). */
    private readonly guestsAllowed: () => boolean = () => true,
  ) {}

  // ── Rooms ──────────────────────────────────────────────────────────────────

  /** Open rooms waiting for a second player. */
  list(): RoomSummary[] {
    const t = this.now();
    return [...this.rooms.values()]
      .filter((r) => !r.closed && !r.players.guest && r.players.host && this.isOnline(r.players.host))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({
        code: r.code,
        host: r.players.host!.name,
        guest: !r.players.host!.userId,
        hostColor: r.hostChoice,
        autoEndTurn: r.autoEndTurn,
        draft: r.draftMode,
        age: Math.round((t - r.createdAt) / 1000),
      }));
  }

  get openRooms(): number {
    return [...this.rooms.values()].filter((r) => !r.closed).length;
  }

  /** Opens a room (a signed-in `member` plays under the account's name). */
  create(body: unknown, member: Member | null = null): Ok<{ seat: Seat; state: RoomState }> {
    if (!isObj(body)) return fail('Érvénytelen kérés.');
    if (!sameBuild(body.build)) return fail(versionError(body.build));
    if (!member && !this.guestsAllowed()) return fail(GUESTS_OFF);
    if (this.openRooms >= MAX_ROOMS) return fail('A szerver tele van – próbáld később.');
    const draftMode = body.draft === true;
    // in a Spell-toborzás room the decks are drafted: the players' own decks are not used
    const deck = draftMode ? [] : cleanDeck(body.deck);
    if (typeof deck === 'string') return fail(deck);
    const choice: ColorChoice = body.color === 'w' || body.color === 'b' ? body.color : 'random';
    const room = this.newRoom(choice, body.autoEndTurn !== false, this.newPlayer(body, deck, 'Házigazda', member), draftMode);
    this.log(`Új szoba: ${room.code} (${room.players.host!.name}${draftMode ? ', spell-toborzás' : ''})`);
    this.membersChanged(room);
    return { ok: true, seat: { code: room.code, token: room.players.host!.token, role: 'host' }, state: this.view(room, 'host') };
  }

  join(code: string, body: unknown, member: Member | null = null): Ok<{ seat: Seat; state: RoomState }> {
    const room = this.rooms.get(code.toUpperCase());
    if (!room || room.closed) return fail('Nincs ilyen nyitott szoba.');
    if (!isObj(body)) return fail('Érvénytelen kérés.');
    if (!sameBuild(body.build)) return fail(versionError(body.build));
    if (!member && !this.guestsAllowed()) return fail(GUESTS_OFF);
    if (room.players.guest) return fail('Ez a szoba már megtelt.');
    if (member && room.players.host?.userId === member.id) return fail('Ez a saját szobád – várd meg, hogy valaki belépjen.');
    const deck = room.draftMode ? [] : cleanDeck(body.deck);
    if (typeof deck === 'string') return fail(deck);
    room.players.guest = this.newPlayer(body, deck, 'Vendég', member);
    this.log(`${room.players.guest.name} csatlakozott: ${room.code}`);
    this.startGame(room, room.hostChoice === 'random' ? (randomInt(2) ? 'w' : 'b') : room.hostChoice);
    return { ok: true, seat: { code: room.code, token: room.players.guest.token, role: 'guest' }, state: this.view(room, 'guest') };
  }

  /**
   * A room for two friends at once (an accepted challenge): not listed, both seats taken, the
   * game starts right away. `host` is the challenger.
   */
  direct(
    host: { member: Member; deck: SpellId[]; deckName: string },
    guest: { member: Member; deck: SpellId[]; deckName: string },
    choice: ColorChoice,
    autoEndTurn: boolean,
    draftMode = false,
  ): { host: { seat: Seat; state: RoomState }; guest: { seat: Seat; state: RoomState } } {
    const make = (p: typeof host, fallback: string) => this.newPlayer({ deckName: p.deckName }, p.deck, fallback, p.member);
    const room = this.newRoom(choice, autoEndTurn, make(host, 'Kihívó'), draftMode);
    room.players.guest = make(guest, 'Kihívott');
    this.startGame(room, choice === 'random' ? (randomInt(2) ? 'w' : 'b') : choice);
    this.log(`Kihívás elfogadva: ${host.member.name} – ${guest.member.name} (${room.code})`);
    return {
      host: { seat: { code: room.code, token: room.players.host!.token, role: 'host' }, state: this.view(room, 'host') },
      guest: { seat: { code: room.code, token: room.players.guest.token, role: 'guest' }, state: this.view(room, 'guest') },
    };
  }

  /** The rooms an account has a seat in (to continue a game on any device). */
  gamesOf(userId: string): MyGame[] {
    const out: MyGame[] = [];
    for (const room of this.rooms.values()) {
      if (room.closed) continue;
      for (const role of ['host', 'guest'] as const) {
        const p = room.players[role];
        if (p?.userId !== userId) continue;
        const other = room.players[role === 'host' ? 'guest' : 'host'];
        out.push({ code: room.code, token: p.token, role, opponent: other?.name ?? null, game: room.game, running: this.running(room) });
      }
    }
    return out;
  }

  /** An account is at a board right now (a running game, connected). */
  isPlaying(userId: string): boolean {
    for (const room of this.rooms.values()) {
      if (room.closed || !this.running(room)) continue;
      for (const role of ['host', 'guest'] as const) {
        const p = room.players[role];
        if (p?.userId === userId && this.isOnline(p)) return true;
      }
    }
    return false;
  }

  /** The rooms for the control panel. */
  overview(): { code: string; host: string; guest: string | null; running: boolean; game: number; age: number }[] {
    const t = this.now();
    return [...this.rooms.values()]
      .filter((r) => !r.closed)
      .map((r) => ({
        code: r.code,
        host: r.players.host?.name ?? '?',
        guest: r.players.guest?.name ?? null,
        running: this.running(r),
        game: r.game,
        age: Math.round((t - r.createdAt) / 1000),
      }));
  }

  /** An account is gone (deleted): its running games are resigned and its rooms closed. */
  removeMember(userId: string): void {
    for (const room of [...this.rooms.values()]) {
      if (room.closed) continue;
      for (const role of ['host', 'guest'] as const) if (room.players[role]?.userId === userId) this.leave(room.code, room.players[role]!.token);
    }
  }

  state(code: string, token: string): Ok<{ state: RoomState }> {
    const found = this.find(code, token);
    if (typeof found === 'string') return fail(found);
    this.seen(found.room, found.role);
    return { ok: true, state: this.view(found.room, found.role) };
  }

  /** Events after `after` (the caller may then wait with `wait` if there are none). */
  events(code: string, token: string, after: number): Ok<{ events: NetEvent[] }> {
    const found = this.find(code, token);
    if (typeof found === 'string') return fail(found);
    this.seen(found.room, found.role);
    return { ok: true, events: found.room.events.filter((e) => e.id > after) };
  }

  /** Calls `wake` once the room has news. Returns the unsubscribe function. */
  wait(code: string, wake: () => void): () => void {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) return () => {};
    room.waiters.add(wake);
    return () => room.waiters.delete(wake);
  }

  /** A long poll is open (true) or has ended (false): keeps the player counted as connected. */
  polling(code: string, token: string, open: boolean): void {
    const found = this.find(code, token);
    if (typeof found === 'string') return;
    const p = found.room.players[found.role]!;
    p.polls = Math.max(0, p.polls + (open ? 1 : -1));
    this.seen(found.room, found.role);
  }

  // ── Play ───────────────────────────────────────────────────────────────────

  act(code: string, body: unknown): Ok<{ n: number }> {
    if (!isObj(body) || typeof body.token !== 'string') return fail('Érvénytelen kérés.');
    const found = this.find(code, body.token);
    if (typeof found === 'string') return fail(found);
    const { room, role } = found;
    this.seen(room, role);
    if (!room.state || !room.hostColor) return fail('A játszma még nem kezdődött el.');
    if (room.closed) return fail('A szoba bezárult.');
    if (body.game !== room.game) return fail('A játszma közben továbbhaladt.', { stale: true });
    const me = colorOf(role, room.hostColor);
    const action = cleanAction(body.action, me);
    if (typeof action === 'string') return fail(action);
    // a resignation stands whatever happened meanwhile; any other step must follow the game its sender saw
    if (action.type !== 'RESIGN' && body.n !== room.actions.length) return fail('A játszma közben továbbhaladt.', { stale: true });
    const who = actor(room.state, action);
    if (who !== 'anyone' && who !== me) return fail('Nem te következel.');
    const nonce = typeof body.nonce === 'string' ? body.nonce.slice(0, 64) : undefined;
    return this.apply(room, action, me, nonce);
  }

  /** Draw offers: offer / accept (the draw is then played as an action) / decline. */
  draw(code: string, token: string, answer: DrawAnswer): Ok {
    const found = this.find(code, token);
    if (typeof found === 'string') return fail(found);
    const { room, role } = found;
    this.seen(room, role);
    if (!room.state || !room.hostColor || room.closed) return fail('Nincs futó játszma.');
    if (room.state.status.kind !== 'playing') return fail('A játszma már véget ért.');
    const me = colorOf(role, room.hostColor);
    const theirs = room.drawOffer === opposite(me);
    if (answer === 'accept' || (answer === 'offer' && theirs)) {
      if (!theirs) return fail('Nincs elfogadható döntetlenajánlat.');
      const r = this.apply(room, { type: 'AGREE_DRAW' }, me);
      return r.ok ? { ok: true } : r;
    }
    if (answer === 'decline') {
      if (!theirs) return fail('Nincs elutasítható ajánlat.');
      room.drawOffer = null;
      this.push(room, { type: 'drawDeclined', game: room.game, by: me });
      return { ok: true };
    }
    if (room.drawOffer === me) return { ok: true };
    room.drawOffer = me;
    this.push(room, { type: 'drawOffer', game: room.game, by: me });
    return { ok: true };
  }

  /** Spell-toborzás: the player whose turn it is takes one spell from the table. */
  pick(code: string, body: unknown): Ok {
    if (!isObj(body) || typeof body.token !== 'string') return fail('Érvénytelen kérés.');
    const found = this.find(code, body.token);
    if (typeof found === 'string') return fail(found);
    const { room, role } = found;
    this.seen(room, role);
    if (room.closed) return fail('A szoba bezárult.');
    if (!room.draft || !room.hostColor) return fail('Most nincs toborzás.');
    if (body.game !== room.game) return fail('A toborzás közben továbbhaladt.', { stale: true });
    if (!hasSpell(body.spell)) return fail('Ismeretlen spell.');
    const me = colorOf(role, room.hostColor);
    const why = pickBlockReason(room.draft, me, body.spell);
    if (why) return fail(why, { stale: why === 'Most nem te választasz.' });
    room.draft = applyPick(room.draft, me, body.spell);
    this.push(room, { type: 'pick', game: room.game, by: me, spell: body.spell });
    if (draftDone(room.draft)) this.launch(room, room.draft.picks, { w: DRAFTED_DECK, b: DRAFTED_DECK });
    return { ok: true };
  }

  /** After a game: both players ask for a rematch → a new game with the colours swapped. */
  rematch(code: string, token: string): Ok {
    const found = this.find(code, token);
    if (typeof found === 'string') return fail(found);
    const { room, role } = found;
    this.seen(room, role);
    if (room.closed) return fail('Az ellenfél már kilépett.');
    if (!room.state || room.state.status.kind === 'playing') return fail('A játszma még tart.');
    if (room.rematch.has(role)) return { ok: true };
    room.rematch.add(role);
    this.push(room, { type: 'rematch', game: room.game, by: role });
    if (room.rematch.size === 2) this.startGame(room, opposite(room.hostColor!));
    return { ok: true };
  }

  /** Leaving: a running game counts as resigned, and the room closes. */
  leave(code: string, token: string): Ok {
    const found = this.find(code, token);
    if (typeof found === 'string') return fail(found);
    const { room, role } = found;
    if (room.closed) return { ok: true };
    const p = room.players[role]!;
    if (room.state && room.hostColor && room.state.status.kind === 'playing') {
      this.apply(room, { type: 'RESIGN', color: colorOf(role, room.hostColor) }, colorOf(role, room.hostColor));
    }
    this.push(room, { type: 'left', role, name: p.name });
    this.close(room, `${p.name} kilépett.`);
    return { ok: true };
  }

  /** Presence and clean-up; call every few seconds. */
  tick(): void {
    const t = this.now();
    for (const room of [...this.rooms.values()]) {
      if (room.closed) {
        if (t - room.closedAt > CLOSED_KEEP_MS) this.rooms.delete(room.code);
        continue;
      }
      for (const role of ['host', 'guest'] as const) {
        const p = room.players[role];
        if (p && p.online && !this.isOnline(p)) {
          p.online = false;
          this.push(room, { type: 'presence', role, online: false });
          this.log(`${p.name} kapcsolata megszakadt (${room.code})`);
        }
      }
      const host = room.players.host!;
      if (!room.players.guest && t - host.lastSeen > HOST_GONE_MS && host.polls === 0) this.close(room, 'A házigazda elment.');
      else if (t - room.touchedAt > IDLE_ROOM_MS) this.close(room, 'A szoba sokáig tétlen volt.');
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private newCode(): string {
    for (;;) {
      const code = Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      if (!this.rooms.has(code)) return code;
    }
  }

  private newRoom(choice: ColorChoice, autoEndTurn: boolean, host: Player, draftMode = false): Room {
    const t = this.now();
    const room: Room = {
      code: this.newCode(),
      createdAt: t,
      touchedAt: t,
      hostChoice: choice,
      autoEndTurn,
      draftMode,
      draft: null,
      players: { host, guest: null },
      game: 0,
      setup: null,
      hostColor: null,
      state: null,
      actions: [],
      drawOffer: null,
      rematch: new Set(),
      events: [],
      nextEvent: 1,
      closed: null,
      closedAt: 0,
      waiters: new Set(),
    };
    this.rooms.set(room.code, room);
    return room;
  }

  private newPlayer(body: Record<string, unknown>, deck: SpellId[], fallback: string, member: Member | null = null): Player {
    return {
      name: member ? member.name : cleanText(body.name, NAME_MAX, fallback),
      userId: member?.id ?? null,
      token: randomUUID(),
      deck,
      deckName: cleanText(body.deckName, DECK_NAME_MAX, 'Pakli'),
      lastSeen: this.now(),
      polls: 0,
      online: true,
    };
  }

  private find(code: string, token: string): { room: Room; role: Role } | string {
    const room = this.rooms.get(String(code).toUpperCase());
    if (!room) return 'Nincs ilyen szoba (lehet, hogy a szerver újraindult).';
    for (const role of ['host', 'guest'] as const) if (room.players[role]?.token === token) return { room, role };
    return 'Ismeretlen játékos ebben a szobában.';
  }

  private isOnline(p: Player): boolean {
    return p.polls > 0 || this.now() - p.lastSeen < OFFLINE_AFTER_MS;
  }

  private seen(room: Room, role: Role): void {
    const p = room.players[role];
    if (!p) return;
    p.lastSeen = this.now();
    room.touchedAt = p.lastSeen;
    if (!p.online && !room.closed) {
      p.online = true;
      this.push(room, { type: 'presence', role, online: true });
      this.log(`${p.name} újra kapcsolódott (${room.code})`);
    }
  }

  /** A new game in the room: at once with the players' decks, or after a draft (Spell-toborzás). */
  private startGame(room: Room, hostColor: Color): void {
    const host = room.players.host!;
    const guest = room.players.guest!;
    const by = (c: Color) => (c === hostColor ? host : guest);
    room.game += 1;
    room.hostColor = hostColor;
    room.state = null;
    room.setup = null;
    room.actions = [];
    room.drawOffer = null;
    room.rematch.clear();
    if (room.draftMode) {
      room.draft = newDraft(randomInt(2 ** 31));
      this.push(room, { type: 'draft', game: room.game, draft: room.draft, hostColor, names: { w: by('w').name, b: by('b').name } });
      this.log(`Spell-toborzás indul (${room.code}, ${room.game}.): Világos ${by('w').name}, Sötét ${by('b').name}`);
      this.membersChanged(room);
      return;
    }
    this.launch(room, { w: [...by('w').deck], b: [...by('b').deck] }, { w: by('w').deckName, b: by('b').deckName });
  }

  /** The game itself begins (game number `room.game`). */
  private launch(room: Room, decks: Record<Color, SpellId[]>, deckNames: Record<Color, string>): void {
    const hostColor = room.hostColor!;
    const by = (c: Color) => (c === hostColor ? room.players.host! : room.players.guest!);
    room.setup = {
      decks: { w: [...decks.w], b: [...decks.b] },
      deckNames: { ...deckNames },
      names: { w: by('w').name, b: by('b').name },
      seed: randomInt(2 ** 31),
      autoEndTurn: room.autoEndTurn,
    };
    room.draft = null;
    room.state = setupGame(room.setup);
    room.actions = [];
    this.push(room, { type: 'start', game: room.game, setup: room.setup, hostColor });
    this.log(`Játszma indul (${room.code}, ${room.game}.): Világos ${room.setup.names.w}, Sötét ${room.setup.names.b}`);
    this.membersChanged(room);
  }

  /** Being drafted or played (not waiting, not over). */
  private running(room: Room): boolean {
    return !!room.draft || (!!room.state && room.state.status.kind === 'playing');
  }

  private membersChanged(room: Room): void {
    const ids = [room.players.host?.userId, room.players.guest?.userId].filter((id): id is string => !!id);
    if (ids.length) this.onMembersChanged(ids);
  }

  private apply(room: Room, action: Action, by: Color, nonce?: string): Ok<{ n: number }> {
    let r: ReturnType<typeof applyAction>;
    try {
      r = applyAction(room.state!, action);
    } catch (e) {
      return fail(`A motor hibát jelzett: ${(e as Error).message}`);
    }
    if (!r.ok) return fail(r.error);
    const n = room.actions.length;
    room.actions.push(action);
    room.state = r.state;
    if (room.drawOffer) room.drawOffer = null;
    this.push(room, { type: 'action', game: room.game, n, action, by, hash: stateHash(r.state), ...(nonce ? { nonce } : {}) });
    const st = r.state.status;
    if (st.kind !== 'playing') {
      const how = st.kind === 'checkmate' ? `matt, ${st.winner === 'w' ? 'Világos' : 'Sötét'} nyert` : st.kind === 'resigned' ? `feladás, ${st.winner === 'w' ? 'Világos' : 'Sötét'} nyert` : st.kind === 'stalemate' ? 'patt' : 'döntetlen';
      this.log(`Vége (${room.code}): ${how}`);
      this.membersChanged(room);
    }
    return { ok: true, n };
  }

  private push(room: Room, e: DistributiveOmit<NetEvent, 'id'>): void {
    room.events.push({ ...e, id: room.nextEvent++ } as NetEvent);
    room.touchedAt = this.now();
    const waiters = [...room.waiters];
    room.waiters.clear();
    waiters.forEach((w) => w());
  }

  private close(room: Room, reason: string): void {
    if (room.closed) return;
    room.closed = reason;
    room.closedAt = this.now();
    this.push(room, { type: 'closed', reason });
    this.log(`Szoba bezárva (${room.code}): ${reason}`);
    this.membersChanged(room);
  }

  private view(room: Room, role: Role): RoomState {
    return {
      code: room.code,
      role,
      names: { host: room.players.host?.name ?? null, guest: room.players.guest?.name ?? null },
      game: room.game,
      draftMode: room.draftMode,
      draft: room.draft,
      setup: room.setup,
      hostColor: room.hostColor,
      actions: [...room.actions],
      drawOffer: room.drawOffer,
      rematch: [...room.rematch],
      online: { host: !!room.players.host && this.isOnline(room.players.host), guest: !!room.players.guest && this.isOnline(room.players.guest) },
      closed: room.closed,
      lastEvent: room.nextEvent - 1,
    };
  }
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

const GUESTS_OFF = 'Ezen a szerveren csak bejelentkezve lehet játszani.';
/** The name a drafted deck plays under. */
export const DRAFTED_DECK = 'Toborzott pakli';

/** Page and server must run the same rules (a development build on either side is let through). */
export const sameBuild = (build: unknown): boolean => BUILD_ID === 'dev' || build === 'dev' || build === BUILD_ID;

export function versionError(build: unknown): string {
  return `A játék verziója (${typeof build === 'string' ? build : '?'}) nem egyezik a szerverével (${BUILD_ID}): a játékoldalnak és a backendnek ugyanabból a kiadásból kell lennie – frissítsd azt, amelyik régebbi.`;
}
