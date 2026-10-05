// Ranked play: the Elo maths, the matchmaking queue (closest rating first, a range that widens
// with the wait), ranked rooms (no rematch, leaving loses, the turn clock), the ratings moving only
// after matchmade games, the leaderboard, the control panel's reset, and old data files.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Action, SpellId } from '../src/engine';
import {
  BUILD_ID, eloAfter, eloExpected, PROVISIONAL_GAMES, queueRange, RANKED_AWAY_MS, RANKED_TURN_MS, RATING_FLOOR, RATING_START,
  type AccountEvent, type NetEvent,
} from '../src/net/protocol';
import { Accounts } from '../server/accounts';
import { Lobby } from '../server/lobby';
import { Matchmaker, QUEUE_STALE_MS } from '../server/ranked';
import { Store } from '../server/store';
import { S } from './helpers';

const DECK: SpellId[] = ['manaMage', 'manaDeposit', 'gambit', 'sacrifice', 'overcharge', 'arcaneSurge'];
const mv = (from: string, to: string): Action => ({ type: 'MOVE', from: S(from), to: S(to) });

describe('the Élő maths', () => {
  it('even players: ±20 while new (K = 40), ±10 later (K = 20); the favourite gains less', () => {
    expect(eloExpected(1000, 1000)).toBeCloseTo(0.5);
    expect(eloAfter(1000, 1000, 1, 0)).toBe(1020);
    expect(eloAfter(1000, 1000, 0, 0)).toBe(980);
    expect(eloAfter(1000, 1000, 0.5, 0)).toBe(1000);
    expect(eloAfter(1000, 1000, 1, PROVISIONAL_GAMES)).toBe(1010);
    expect(eloAfter(1400, 1000, 1, 50) - 1400).toBeLessThan(5); // expected to win: a small gain
    expect(eloAfter(1000, 1400, 1, 50) - 1000).toBeGreaterThan(15); // the upset pays
    expect(eloAfter(1400, 1000, 0.5, 50)).toBeLessThan(1400); // a draw against a weaker player costs
  });

  it('nobody falls below the floor', () => {
    expect(eloAfter(RATING_FLOOR, 2000, 0, 0)).toBe(RATING_FLOOR);
    expect(eloAfter(RATING_FLOOR + 5, RATING_FLOOR + 5, 0, 0)).toBe(RATING_FLOOR);
  });

  it('the search range widens with the wait, then anyone will do', () => {
    expect(queueRange(0)).toBe(100);
    expect(queueRange(4999)).toBe(100);
    expect(queueRange(5000)).toBe(150);
    expect(queueRange(30_000)).toBe(400);
    expect(queueRange(59_999)).toBe(650);
    expect(queueRange(60_000)).toBeNull();
  });
});

describe('the matchmaker', () => {
  const setup = () => {
    const clock = { t: 1_000_000 };
    const ratings: Record<string, number> = {};
    const mm = new Matchmaker(() => clock.t);
    const join = (id: string, rating: number) => {
      ratings[id] = rating;
      mm.join(id, DECK, 'Pakli');
    };
    const pairs = () => mm.pairs((id) => ratings[id]).map(([a, b]) => [a.userId, b.userId].sort().join('+'));
    return { clock, mm, join, pairs };
  };

  it('pairs the closest ratings inside the range; nobody plays themselves', () => {
    const { mm, join, pairs } = setup();
    join('a', 1000);
    expect(pairs()).toEqual([]);
    join('far', 1400);
    expect(pairs()).toEqual([]); // 400 apart: not yet
    join('near', 1060);
    join('nearer', 1020);
    expect(pairs()).toEqual(['a+nearer']); // the oldest first, with the closest
    expect(mm.has('a') || mm.has('nearer')).toBe(false);
    expect(mm.size).toBe(2);
  });

  it('waiting widens the range: after a minute anyone will do', () => {
    const { clock, mm, join, pairs } = setup();
    join('a', 1000);
    join('b', 1380);
    expect(pairs()).toEqual([]);
    clock.t += 25_000; // ±350 now
    for (const id of ['a', 'b']) mm.seen(id);
    expect(pairs()).toEqual([]);
    clock.t += 5_000; // ±400
    for (const id of ['a', 'b']) mm.seen(id);
    expect(pairs()).toEqual(['a+b']);
    join('low', 100);
    join('high', 2900);
    clock.t += 10_000;
    for (const id of ['low', 'high']) mm.seen(id);
    expect(pairs()).toEqual([]);
    clock.t += 50_000;
    for (const id of ['low', 'high']) mm.seen(id);
    expect(pairs()).toEqual(['high+low']);
  });

  it('a page that stops asking is dropped; joining again keeps the place in the queue', () => {
    const { clock, mm, join } = setup();
    join('a', 1000);
    clock.t += 10_000;
    join('a', 1000); // a new deck, the same wait
    expect(mm.view('a')).toMatchObject({ waited: 10, range: 200, searching: 1 });
    clock.t += QUEUE_STALE_MS - 1;
    expect(mm.sweep()).toEqual([]);
    clock.t += 2;
    expect(mm.sweep().map((w) => w.userId)).toEqual(['a']);
    expect(mm.view('a')).toBeNull();
  });
});

/** A server in memory with a fake clock: accounts, lobby, players. */
function world() {
  const clock = { t: 50_000_000 };
  const now = () => clock.t;
  const store = new Store(null);
  store.data.settings.registration = 'open';
  const logs: string[] = [];
  const lobby = new Lobby(() => {}, now, () => true);
  const acc = new Accounts(store, lobby, (m) => logs.push(m), now);
  const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
    if (!r.ok) throw new Error((r as unknown as { error: string }).error);
    return r as Extract<T, { ok: true }>;
  };
  const player = async (name: string) => {
    ok(await acc.register({ name, password: 'titok123' }, '10.0.0.9'));
    const user = acc.byName(name)!;
    return { user, events: () => acc.events(user, 0).events };
  };
  const seatOf = (p: { events: () => AccountEvent[] }) => p.events().filter((e): e is Extract<AccountEvent, { type: 'game' }> => e.type === 'game').at(-1);
  /** Two players paired by matchmaking: their seats (white first). */
  const ranked = async (an = 'Anna', bn = 'Bence') => {
    const a = await player(an);
    const b = await player(bn);
    ok(acc.rankedJoin(a.user, { deck: DECK, deckName: 'A', build: BUILD_ID }));
    const second = ok(acc.rankedJoin(b.user, { deck: DECK, deckName: 'B', build: BUILD_ID }));
    expect(second.queue).toBeNull(); // found at once
    const sa = seatOf(a)!;
    const sb = seatOf(b)!;
    const hostColor = sa.state.hostColor!;
    const colorOfA = sa.seat.role === 'host' ? hostColor : hostColor === 'w' ? 'b' : 'w';
    const white = colorOfA === 'w' ? { p: a, s: sa } : { p: b, s: sb };
    const black = colorOfA === 'w' ? { p: b, s: sb } : { p: a, s: sa };
    return { a, b, white, black, code: sa.seat.code };
  };
  const roomEvents = (code: string, token: string): NetEvent[] => {
    const r = lobby.events(code, token, 0);
    return r.ok ? r.events : [];
  };
  return { clock, store, lobby, acc, logs, ok, player, ranked, roomEvents };
}

describe('ranked games', () => {
  it('matchmaking opens a ranked room for both: random colours, own decks, the ratings in the room', async () => {
    const w = await world();
    const { a, b, white, black, code } = await w.ranked();
    for (const p of [a, b]) {
      const e = p.events().find((x) => x.type === 'game') as Extract<AccountEvent, { type: 'game' }>;
      expect(e.ranked).toBe(true);
      expect(e.state.ranked).toEqual({ host: RATING_START, guest: RATING_START });
      expect(e.state.setup!.autoEndTurn).toBe(true);
      expect(e.state.setup!.decks.w).toEqual(DECK);
    }
    expect(w.acc.me(a.user).games).toEqual([expect.objectContaining({ code, ranked: true, running: true })]);
    // already playing: no second search
    expect(w.acc.rankedJoin(white.p.user, { deck: DECK, deckName: 'A', build: BUILD_ID })).toMatchObject({ ok: false, error: expect.stringMatching(/futó játszmádat/) });
    expect(w.lobby.overview()).toEqual([expect.objectContaining({ code, ranked: true })]);
    expect(black.s.state.turnLeftMs).toBe(RANKED_TURN_MS);
  });

  it('the result moves both ratings; the room says so; no rematch', async () => {
    const w = await world();
    const { white, black, code } = await w.ranked();
    w.ok(w.lobby.act(code, { token: white.s.seat.token, game: 1, n: 0, action: mv('e2', 'e4'), nonce: 'x' }));
    w.ok(w.lobby.act(code, { token: black.s.seat.token, game: 1, n: 1, action: { type: 'RESIGN', color: 'b' }, nonce: 'y' }));
    expect(white.p.user.rating).toBe(1020);
    expect(black.p.user.rating).toBe(980);
    expect(white.p.user.ranked).toEqual({ w: 1, l: 0, d: 0 });
    expect(black.p.user.ranked).toEqual({ w: 0, l: 1, d: 0 });
    const rated = w.roomEvents(code, white.s.seat.token).find((e) => e.type === 'rated');
    expect(rated).toMatchObject({ changes: { w: { before: 1000, after: 1020 }, b: { before: 1000, after: 980 } } });
    const st = w.ok(w.lobby.state(code, black.s.seat.token)).state;
    expect(st.rated).toEqual({ w: { before: 1000, after: 1020 }, b: { before: 1000, after: 980 } });
    expect(st.turnLeftMs).toBeNull();
    expect(w.lobby.rematch(code, white.s.seat.token)).toMatchObject({ ok: false, error: expect.stringMatching(/nincs visszavágó/) });
    expect(w.acc.me(white.p.user).user).toMatchObject({ rating: 1020, ranked: { w: 1, l: 0, d: 0 }, rank: 1 });
    expect(w.acc.me(black.p.user).user).toMatchObject({ rating: 980, rank: 2 });
    expect(w.logs.some((l) => /Élő-pontszám .*1000 → 1020/.test(l))).toBe(true);
  });

  it('a draw by agreement: both keep 1000, a draw on the record', async () => {
    const w = await world();
    const { white, black, code } = await w.ranked();
    w.ok(w.lobby.draw(code, white.s.seat.token, 'offer'));
    w.ok(w.lobby.draw(code, black.s.seat.token, 'accept'));
    expect([white.p.user.rating, black.p.user.rating]).toEqual([1000, 1000]);
    expect(white.p.user.ranked).toEqual({ w: 0, l: 0, d: 1 });
  });

  it('leaving a ranked game loses it', async () => {
    const w = await world();
    const { white, black, code } = await w.ranked();
    w.ok(w.lobby.leave(code, white.s.seat.token));
    expect(white.p.user.rating).toBe(980);
    expect(black.p.user.rating).toBe(1020);
  });

  it('friendly games never touch the rating (rooms and challenges)', async () => {
    const w = await world();
    const a = await w.player('Anna');
    const b = await w.player('Bence');
    const room = w.ok(w.lobby.create({ name: '', deck: DECK, deckName: 'A', color: 'w', autoEndTurn: true, build: BUILD_ID }, { id: a.user.id, name: 'Anna' }));
    const joined = w.ok(w.lobby.join(room.seat.code, { name: '', deck: DECK, deckName: 'B', build: BUILD_ID }, { id: b.user.id, name: 'Bence' }));
    expect(joined.state.ranked).toBeNull();
    w.ok(w.lobby.act(room.seat.code, { token: joined.seat.token, game: 1, n: 0, action: { type: 'RESIGN', color: 'b' }, nonce: 'z' }));
    expect([a.user.rating, b.user.rating]).toEqual([1000, 1000]);
    expect(a.user.ranked).toEqual({ w: 0, l: 0, d: 0 });
    expect(w.roomEvents(room.seat.code, joined.seat.token).some((e) => e.type === 'rated')).toBe(false);
    expect(w.acc.me(a.user).user.rank).toBeNull();
  });

  it('the turn clock: three minutes for a turn, then the player to move loses', async () => {
    const w = await world();
    const { white, black, code } = await w.ranked();
    const seen = () => {
      w.lobby.state(code, white.s.seat.token);
      w.lobby.state(code, black.s.seat.token);
    };
    w.ok(w.lobby.act(code, { token: white.s.seat.token, game: 1, n: 0, action: mv('e2', 'e4'), nonce: 'x' }));
    // black thinks… both pages keep polling
    for (let s = 0; s < RANKED_TURN_MS / 1000; s += 5) {
      w.clock.t += 5000;
      seen();
      w.lobby.tick();
    }
    expect(w.ok(w.lobby.state(code, black.s.seat.token)).state.forfeit).toBeNull(); // the grace
    w.clock.t += 6000;
    seen();
    w.lobby.tick();
    const st = w.ok(w.lobby.state(code, white.s.seat.token)).state;
    expect(st.forfeit).toEqual({ by: 'b', reason: 'time' });
    expect(w.roomEvents(code, white.s.seat.token).map((e) => e.type)).toEqual(expect.arrayContaining(['forfeit', 'action', 'rated']));
    expect(white.p.user.rating).toBe(1020);
  });

  it('away for a minute loses; when both are away nobody does and the clock waits', async () => {
    const w = await world();
    const { white, black, code } = await w.ranked();
    // both gone (the server's own network?): two minutes pass, nothing happens
    w.clock.t += 120_000;
    w.lobby.tick();
    expect(w.ok(w.lobby.state(code, white.s.seat.token)).state.forfeit).toBeNull();
    // white is back (and keeps polling); black stays away
    const left = w.ok(w.lobby.state(code, white.s.seat.token)).state.turnLeftMs!;
    expect(left).toBeGreaterThan(RANKED_TURN_MS - 10_000); // the clock waited
    for (let s = 0; s < RANKED_AWAY_MS / 1000 + 10; s += 3) {
      w.clock.t += 3000;
      w.lobby.state(code, white.s.seat.token);
      w.lobby.tick();
    }
    const st = w.ok(w.lobby.state(code, white.s.seat.token)).state;
    expect(st.forfeit).toEqual({ by: 'b', reason: 'away' });
    expect(black.p.user.rating).toBe(980);
  });

  it('the queue: a quiet page drops out; leaving the queue; status keeps the place', async () => {
    const w = await world();
    const a = await w.player('Anna');
    expect(w.ok(w.acc.rankedJoin(a.user, { deck: DECK, deckName: 'A', build: BUILD_ID })).queue).toMatchObject({ waited: 0, range: 100, searching: 1 });
    w.clock.t += 10_000;
    expect(w.ok(w.acc.rankedStatus(a.user)).queue).toMatchObject({ waited: 10, range: 200 });
    w.clock.t += QUEUE_STALE_MS + 1;
    w.acc.tick();
    expect(w.ok(w.acc.rankedStatus(a.user)).queue).toBeNull();
    w.ok(w.acc.rankedJoin(a.user, { deck: DECK, deckName: 'A', build: BUILD_ID }));
    w.ok(w.acc.rankedLeave(a.user));
    expect(w.ok(w.acc.rankedStatus(a.user)).queue).toBeNull();
    expect(w.acc.rankedJoin(a.user, { deck: ['nope'], deckName: 'A', build: BUILD_ID }).ok).toBe(false);
  });

  it('the leaderboard ranks players with ranked games; the control panel can reset a rating', async () => {
    const w = await world();
    const { white, black } = await w.ranked('Anna', 'Bence');
    const c = await w.player('Csaba'); // never played ranked
    w.ok(w.lobby.leave(w.acc.me(black.p.user).games[0].code, w.acc.me(black.p.user).games[0].token));
    const lb = w.ok(w.acc.leaderboard(c.user));
    expect(lb.players).toBe(2);
    expect(lb.rows.map((r) => [r.rank, r.name, r.rating])).toEqual([
      [1, white.p.user.name, 1020],
      [2, black.p.user.name, 980],
    ]);
    expect(lb.me).toBeNull();
    expect(w.ok(w.acc.leaderboard(black.p.user)).rows[1].me).toBe(true);
    const admin = w.acc.adminUsers().find((u) => u.id === white.p.user.id)!;
    expect(admin).toMatchObject({ rating: 1020, rankedGames: 1 });
    w.ok(w.acc.resetRating({ id: white.p.user.id }));
    expect(white.p.user).toMatchObject({ rating: RATING_START, ranked: { w: 0, l: 0, d: 0 } });
    expect(w.ok(w.acc.leaderboard(c.user)).players).toBe(1);
  });

  it('a deleted account leaves the queue', async () => {
    const w = await world();
    const admin = await w.player('Admin');
    admin.user.role = 'admin';
    const a = await w.player('Anna');
    w.ok(w.acc.rankedJoin(a.user, { deck: DECK, deckName: 'A', build: BUILD_ID }));
    w.ok(w.acc.remove(admin.user, { id: a.user.id }));
    expect(w.acc.matchmaker.size).toBe(0);
  });
});

describe('the data file', () => {
  it('accounts saved before ranked play get 1000 and an empty record; the new fields are saved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mana-ranked-'));
    try {
      const file = join(dir, 'data.json');
      const old = {
        version: 1,
        settings: {},
        users: [
          { id: 'u1', name: 'Régi', key: 'régi', pass: 'x', role: 'user', status: 'active', createdAt: 1, lastLogin: null, decks: [], friends: [], requestsIn: [], requestsOut: [], failed: 0, lockedUntil: 0 },
          { id: 'u2', name: 'Fura', key: 'fura', pass: 'x', role: 'user', status: 'active', createdAt: 1, lastLogin: null, decks: [], friends: [], requestsIn: [], requestsOut: [], failed: 0, lockedUntil: 0, rating: 'sok', ranked: { w: -3, l: 2.5, d: 4 } },
        ],
        sessions: [],
        bans: [],
      };
      writeFileSync(file, JSON.stringify(old));
      const store = new Store(file);
      expect(store.data.users[0]).toMatchObject({ name: 'Régi', rating: RATING_START, ranked: { w: 0, l: 0, d: 0 } });
      expect(store.data.users[1]).toMatchObject({ rating: RATING_START, ranked: { w: 0, l: 0, d: 4 } });
      expect(store.data.users[0].decks).toEqual([]); // everything else as it was
      store.flush();
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      expect(saved.users[0]).toMatchObject({ rating: RATING_START, ranked: { w: 0, l: 0, d: 0 }, pass: 'x' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
