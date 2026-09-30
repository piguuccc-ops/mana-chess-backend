// Online play: the protocol helpers, the server's rooms (authority, draws, rematches, leaving,
// presence) and a real HTTP round trip with two clients.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyAction, pickBlockReason, SPELL_LIST } from '../src/engine';
import type { Action, SpellId } from '../src/engine';
import { normalizeServer, OnlineSession } from '../src/net/client';
import { BUILD_ID, colorOf, DEFAULT_PORT, replay, setupGame, stateHash, type NetEvent, type RoomState, type Setup } from '../src/net/protocol';
import { startBackend, type RunningBackend } from '../server/index';
import { Lobby, OFFLINE_AFTER_MS } from '../server/lobby';
import { S } from './helpers';

/** A legal deck with nothing that could block a check (so a quick mate stays a mate). */
const DECK: SpellId[] = ['manaMage', 'manaDeposit', 'gambit', 'sacrifice', 'overcharge', 'arcaneSurge'];
const req = (name: string, extra: object = {}) => ({ name, deck: DECK, deckName: 'Mana', color: 'w', autoEndTurn: true, build: BUILD_ID, ...extra });
const mv = (from: string, to: string): Action => ({ type: 'MOVE', from: S(from), to: S(to) });

function table(clock = { t: 1_000_000 }) {
  const lobby = new Lobby(() => {}, () => clock.t);
  const host = lobby.create(req('Anna'));
  if (!host.ok) throw new Error(host.error);
  const guest = lobby.join(host.seat.code, req('Bence'));
  if (!guest.ok) throw new Error(guest.error);
  const play = (who: 'host' | 'guest', action: Action, n: number) =>
    lobby.act(host.seat.code, { token: (who === 'host' ? host : guest).seat.token, game: 1, n, action, nonce: `x${n}` });
  const events = (who: 'host' | 'guest', after = 0) => {
    const r = lobby.events(host.seat.code, (who === 'host' ? host : guest).seat.token, after);
    if (!r.ok) throw new Error(r.error);
    return r.events;
  };
  return { lobby, clock, host, guest, code: host.seat.code, play, events };
}

describe('protocol', () => {
  const setup: Setup = { decks: { w: DECK, b: DECK }, deckNames: { w: 'A', b: 'B' }, names: { w: 'Anna', b: 'Bence' }, seed: 42, autoEndTurn: true };

  it('replays a game and fingerprints positions', () => {
    const g0 = setupGame(setup);
    const moves = [mv('e2', 'e4'), mv('e7', 'e5')];
    const g2 = replay(setup, moves);
    expect(stateHash(g2)).not.toBe(stateHash(g0));
    expect(stateHash(replay(setup, moves))).toBe(stateHash(g2)); // deterministic
    const other = replay({ ...setup, seed: 43 }, moves);
    expect(stateHash(other)).not.toBe(stateHash(g2)); // the seed is part of the game
    expect(() => replay(setup, [mv('e2', 'e5')])).toThrow();
  });

  it('colours of the seats, server addresses', () => {
    expect(colorOf('host', 'w')).toBe('w');
    expect(colorOf('guest', 'w')).toBe('b');
    expect(colorOf('guest', 'b')).toBe('w');
    expect(normalizeServer('192.168.1.23')).toBe(`http://192.168.1.23:${DEFAULT_PORT}`);
    expect(normalizeServer('192.168.1.23:9000')).toBe('http://192.168.1.23:9000');
    expect(normalizeServer('https://mana.example.org')).toBe('https://mana.example.org');
    expect(normalizeServer('')).toBeNull();
  });
});

describe('server rooms', () => {
  it('a room opens, the second player starts the game with the chosen colours', () => {
    const t = table();
    expect(t.lobby.list()).toEqual([]); // full rooms are not listed
    const start = t.events('host').find((e) => e.type === 'start');
    expect(start).toMatchObject({ type: 'start', game: 1, hostColor: 'w' });
    if (start?.type !== 'start') return;
    expect(start.setup.names).toEqual({ w: 'Anna', b: 'Bence' });
    expect(start.setup.decks.w).toEqual(DECK);
    expect(t.guest.ok && t.guest.state.setup).toEqual(start.setup);

    const open = new Lobby().create(req('Csaba', { color: 'random' }));
    expect(open.ok).toBe(true);
  });

  it('only the player to move may act, in order, with legal moves', () => {
    const t = table();
    expect(t.play('guest', mv('e7', 'e5'), 0)).toMatchObject({ ok: false, error: 'Nem te következel.' });
    expect(t.play('host', mv('e2', 'e5'), 0).ok).toBe(false); // illegal: the engine says no
    expect(t.play('host', mv('e2', 'e4'), 0)).toEqual({ ok: true, n: 0 });
    expect(t.play('host', mv('d2', 'd4'), 0)).toMatchObject({ ok: false, stale: true }); // n = 0 is taken
    expect(t.play('guest', mv('e7', 'e5'), 1)).toEqual({ ok: true, n: 1 });
    const acts = t.events('guest').filter((e) => e.type === 'action');
    expect(acts.map((e) => e.type === 'action' && e.n)).toEqual([0, 1]);
    expect(acts[0]).toMatchObject({ by: 'w', nonce: 'x0' });
    // the hash matches what a client gets by replaying
    const start = t.events('guest').find((e) => e.type === 'start');
    if (start?.type !== 'start' || acts[1].type !== 'action') throw new Error('events');
    expect(acts[1].hash).toBe(stateHash(replay(start.setup, [mv('e2', 'e4'), mv('e7', 'e5')])));
  });

  it('refuses rubbish from the network', () => {
    const t = table();
    const tok = t.host.ok ? t.host.seat.token : '';
    expect(t.lobby.act(t.code, { token: tok, game: 1, n: 0, action: { type: 'CAST', spellId: '__proto__', targets: [] } }).ok).toBe(false);
    expect(t.lobby.act(t.code, { token: tok, game: 1, n: 0, action: { type: 'MOVE', from: -1, to: 99 } }).ok).toBe(false);
    expect(t.lobby.act(t.code, { token: tok, game: 1, n: 0, action: { type: 'AGREE_DRAW' } }).ok).toBe(false); // only through an offer
    expect(t.lobby.act(t.code, { token: 'nope', game: 1, n: 0, action: mv('e2', 'e4') }).ok).toBe(false);
    expect(new Lobby().create(req('X', { deck: ['__proto__', ...DECK.slice(1)] })).ok).toBe(false);
    expect(new Lobby().create(req('X', { deck: ['meteor', 'dragonFire', ...DECK.slice(2)] })).ok).toBe(false); // two 6-mana spells
    // a resignation is always for the sender's own colour
    t.lobby.act(t.code, { token: tok, game: 1, n: 0, action: { type: 'RESIGN', color: 'b' } });
    const st = t.lobby.state(t.code, tok);
    expect(st.ok && replay(st.state.setup!, st.state.actions).status).toEqual({ kind: 'resigned', winner: 'b' });
  });

  it('a fool’s mate ends the game; both ask for a rematch and the colours swap', () => {
    const t = table();
    [mv('f2', 'f3'), mv('e7', 'e5'), mv('g2', 'g4'), mv('d8', 'h4')].forEach((a, n) => expect(t.play(n % 2 ? 'guest' : 'host', a, n).ok).toBe(true));
    const tok = t.guest.ok ? t.guest.seat.token : '';
    const st = t.lobby.state(t.code, tok);
    expect(st.ok && replay(st.state.setup!, st.state.actions).status).toEqual({ kind: 'checkmate', winner: 'b' });
    expect(t.play('host', mv('a2', 'a3'), 4).ok).toBe(false); // over
    expect(t.lobby.rematch(t.code, tok).ok).toBe(true);
    expect(t.events('host').filter((e) => e.type === 'start')).toHaveLength(1); // one request is not enough
    expect(t.lobby.rematch(t.code, t.host.ok ? t.host.seat.token : '').ok).toBe(true);
    const starts = t.events('host').filter((e): e is Extract<NetEvent, { type: 'start' }> => e.type === 'start');
    expect(starts.map((e) => [e.game, e.hostColor])).toEqual([[1, 'w'], [2, 'b']]);
    expect(starts[1].setup.names).toEqual({ w: 'Bence', b: 'Anna' });
    // the new game starts from scratch: the guest (now White) moves first
    expect(t.lobby.act(t.code, { token: tok, game: 2, n: 0, action: mv('e2', 'e4') }).ok).toBe(true);
  });

  it('draw offers: offer, decline, offer again, accept', () => {
    const t = table();
    const [ht, gt] = [t.host.ok ? t.host.seat.token : '', t.guest.ok ? t.guest.seat.token : ''];
    expect(t.lobby.draw(t.code, gt, 'accept').ok).toBe(false); // nothing to accept
    expect(t.lobby.draw(t.code, ht, 'offer').ok).toBe(true);
    expect(t.lobby.draw(t.code, gt, 'decline').ok).toBe(true);
    expect(t.lobby.draw(t.code, gt, 'offer').ok).toBe(true);
    expect(t.lobby.draw(t.code, ht, 'accept').ok).toBe(true);
    const kinds = t.events('host').map((e) => e.type);
    expect(kinds).toEqual(['start', 'drawOffer', 'drawDeclined', 'drawOffer', 'action']);
    const st = t.lobby.state(t.code, ht);
    expect(st.ok && replay(st.state.setup!, st.state.actions).status).toMatchObject({ kind: 'draw' });
  });

  it('a move cancels a standing draw offer', () => {
    const t = table();
    const ht = t.host.ok ? t.host.seat.token : '';
    t.lobby.draw(t.code, ht, 'offer');
    t.play('host', mv('e2', 'e4'), 0);
    expect(t.lobby.draw(t.code, t.guest.ok ? t.guest.seat.token : '', 'accept').ok).toBe(false);
  });

  it('leaving a running game resigns it and closes the room', () => {
    const t = table();
    expect(t.lobby.leave(t.code, t.guest.ok ? t.guest.seat.token : '').ok).toBe(true);
    const ev = t.events('host');
    expect(ev.map((e) => e.type)).toEqual(['start', 'action', 'left', 'closed']);
    const st = t.lobby.state(t.code, t.host.ok ? t.host.seat.token : '');
    expect(st.ok && st.state.closed).toBeTruthy();
    expect(st.ok && replay(st.state.setup!, st.state.actions).status).toEqual({ kind: 'resigned', winner: 'w' });
    expect(t.lobby.rematch(t.code, t.host.ok ? t.host.seat.token : '').ok).toBe(false);
  });

  it('presence: silence shows a player as disconnected, the next poll brings them back', () => {
    const t = table();
    t.clock.t += OFFLINE_AFTER_MS + 1000;
    t.events('host'); // the host is still polling
    t.lobby.tick();
    const after = t.events('host').filter((e) => e.type === 'presence');
    expect(after).toEqual([expect.objectContaining({ type: 'presence', role: 'guest', online: false })]);
    t.events('guest');
    expect(t.events('host').filter((e) => e.type === 'presence').at(-1)).toMatchObject({ role: 'guest', online: true });
  });

  it('an open room is listed until its host goes away', () => {
    const clock = { t: 5_000_000 };
    const lobby = new Lobby(() => {}, () => clock.t);
    const r = lobby.create(req('Dóra', { color: 'b', autoEndTurn: false }));
    expect(lobby.list()).toEqual([expect.objectContaining({ host: 'Dóra', hostColor: 'b', autoEndTurn: false })]);
    clock.t += 120_000;
    lobby.tick();
    expect(lobby.list()).toEqual([]);
    expect(r.ok && lobby.join(r.seat.code, req('Emil')).ok).toBe(false);
  });
});

describe('Spell-toborzás rooms', () => {
  const draftTable = (extra: object = {}) => {
    const lobby = new Lobby(() => {}, () => 1_000_000);
    const host = lobby.create(req('Anna', { draft: true, deck: [], ...extra }));
    if (!host.ok) throw new Error(host.error);
    return { lobby, host, code: host.seat.code };
  };

  it('the second player starts a draft, not a game; the picks alternate; the drafted decks start the game', () => {
    const { lobby, host, code } = draftTable();
    expect(lobby.list()[0]).toMatchObject({ code, draft: true });
    const guest = lobby.join(code, req('Bence', { deck: ['nem', 'pakli'] })); // a draft room ignores the deck
    if (!guest.ok) throw new Error(guest.error);
    const st = guest.state;
    expect(st).toMatchObject({ game: 1, draftMode: true, setup: null, hostColor: 'w' });
    expect(st.draft!.pool).toHaveLength(32);
    const tok = { host: host.seat.token, guest: guest.seat.token };
    const colorTok = (c: 'w' | 'b') => (c === 'w' ? tok.host : tok.guest); // the host plays Világos (req: color w)
    expect(lobby.act(code, { token: tok.host, game: 1, n: 0, action: { type: 'END_TURN' }, nonce: 'x' })).toMatchObject({ ok: false });
    let draft = st.draft!;
    // Sötét may not start; Világos takes the first card
    expect(lobby.pick(code, { token: tok.guest, game: 1, spell: draft.pool[0] })).toMatchObject({ ok: false, stale: true });
    const taken: string[] = [];
    for (let i = 0; i < 12; i++) {
      const who: 'w' | 'b' = i % 2 === 0 ? 'w' : 'b';
      const id = draft.pool.find((s) => !taken.includes(s) && pickBlockReason(draft, who, s) === null)!;
      expect(lobby.pick(code, { token: colorTok(who), game: 1, spell: id })).toEqual({ ok: true });
      taken.push(id);
      const now = lobby.state(code, tok.host);
      if (!now.ok) throw new Error(now.error);
      if (i < 11) {
        draft = now.state.draft!;
        // a card already taken is refused
        expect(lobby.pick(code, { token: colorTok(who === 'w' ? 'b' : 'w'), game: 1, spell: id })).toMatchObject({ ok: false });
      } else {
        expect(now.state.draft).toBeNull();
        expect(now.state.setup!.decks.w).toEqual(taken.filter((_, k) => k % 2 === 0));
        expect(now.state.setup!.decks.b).toEqual(taken.filter((_, k) => k % 2 === 1));
        expect(now.state.setup!.deckNames).toEqual({ w: 'Toborzott pakli', b: 'Toborzott pakli' });
      }
    }
    const ev = lobby.events(code, tok.guest, 0);
    if (!ev.ok) throw new Error(ev.error);
    const types = ev.events.map((e) => e.type);
    expect(types.filter((t) => t === 'pick')).toHaveLength(12);
    expect(types.indexOf('draft')).toBeLessThan(types.indexOf('pick'));
    expect(types[types.length - 1]).toBe('start');
    expect(ev.events.find((e) => e.type === 'start')).toMatchObject({ game: 1 });
    // the game is on
    expect(lobby.act(code, { token: tok.host, game: 1, n: 0, action: mv('e2', 'e4'), nonce: 'a' })).toEqual({ ok: true, n: 0 });
  });

  it('a stale pick, a spell not on the table, a stranger', () => {
    const { lobby, host, code } = draftTable();
    const guest = lobby.join(code, req('Bence'));
    if (!guest.ok) throw new Error(guest.error);
    const d = guest.state.draft!;
    expect(lobby.pick(code, { token: host.seat.token, game: 2, spell: d.pool[0] })).toMatchObject({ ok: false, stale: true });
    const outside = SPELL_LIST.map((s) => s.id).find((id) => !d.pool.includes(id))!;
    expect(lobby.pick(code, { token: host.seat.token, game: 1, spell: outside })).toMatchObject({ ok: false });
    expect(lobby.pick(code, { token: host.seat.token, game: 1, spell: 'nincsilyen' })).toMatchObject({ ok: false });
    expect(lobby.pick(code, { token: 'idegen', game: 1, spell: d.pool[0] })).toMatchObject({ ok: false });
  });

  it('a rematch drafts again, with a new table and the colours swapped', () => {
    const { lobby, host, code } = draftTable();
    const guest = lobby.join(code, req('Bence'));
    if (!guest.ok) throw new Error(guest.error);
    const first = guest.state.draft!;
    let d = first;
    for (let i = 0; i < 12; i++) {
      const who: 'w' | 'b' = i % 2 === 0 ? 'w' : 'b';
      const id = d.pool.find((s) => pickBlockReason(d, who, s) === null)!;
      expect(lobby.pick(code, { token: who === 'w' ? host.seat.token : guest.seat.token, game: 1, spell: id }).ok).toBe(true);
      const st = lobby.state(code, host.seat.token);
      if (st.ok && st.state.draft) d = st.state.draft;
    }
    expect(lobby.act(code, { token: host.seat.token, game: 1, n: 0, action: { type: 'RESIGN', color: 'w' }, nonce: 'r' }).ok).toBe(true);
    lobby.rematch(code, host.seat.token);
    lobby.rematch(code, guest.seat.token);
    const again = lobby.state(code, guest.seat.token);
    if (!again.ok) throw new Error(again.error);
    expect(again.state).toMatchObject({ game: 2, hostColor: 'b', setup: null });
    expect(again.state.draft!.pool).not.toEqual(first.pool);
    expect(again.state.draft!.picks).toEqual({ w: [], b: [] });
  });

  it('leaving during the draft closes the room', () => {
    const { lobby, host, code } = draftTable();
    const guest = lobby.join(code, req('Bence'));
    if (!guest.ok) throw new Error(guest.error);
    expect(lobby.leave(code, guest.seat.token)).toEqual({ ok: true });
    const st = lobby.state(code, host.seat.token);
    expect(st.ok && st.state.closed).toMatch(/kilépett/);
  });
});

describe('server over HTTP', () => {
  let srv: RunningBackend;
  let base = '';
  beforeAll(async () => {
    srv = await startBackend({ port: 0, host: '127.0.0.1', dataFile: null });
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(() => srv.close());

  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) }).then((r) => r.json());

  it('answers the info call with CORS headers, and preflights', async () => {
    const r = await fetch(`${base}/api/info`);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(await r.json()).toMatchObject({ app: 'mana-chess', build: BUILD_ID, guests: true, registration: 'approval' });
    const pre = await fetch(`${base}/api/rooms`, { method: 'OPTIONS', headers: { 'Access-Control-Request-Private-Network': 'true' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-private-network')).toBe('true');
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const big = await fetch(`${base}/api/rooms`, { method: 'POST', body: 'x'.repeat(100_000) }).catch(() => null);
    expect(big === null || big.status === 400).toBe(true);
  });

  it('two players: a game through the long poll, both replicas stay identical', async () => {
    const created = await post('/api/rooms', req('Anna'));
    expect(created.ok).toBe(true);
    const hostSession = new OnlineSession(base, created.seat, created.state as RoomState);
    const hostEvents: NetEvent[] = [];
    hostSession.subscribe(0, (e) => hostEvents.push(e));
    hostSession.start();
    await new Promise((ok) => setTimeout(ok, 150)); // the host's poll is now waiting

    const joined = await post(`/api/rooms/${created.seat.code}/join`, req('Bence'));
    expect(joined.ok).toBe(true);
    const guestState = joined.state as RoomState;
    const guestSession = new OnlineSession(base, joined.seat, guestState);
    const guestEvents: NetEvent[] = [];
    guestSession.subscribe(guestState.lastEvent, (e) => guestEvents.push(e));
    guestSession.start();

    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 100 && !cond(); i++) await new Promise((ok) => setTimeout(ok, 20));
      expect(cond()).toBe(true);
    };
    await until(() => hostEvents.some((e) => e.type === 'start')); // woken up well before the 25 s timeout

    const moves = [mv('f2', 'f3'), mv('e7', 'e5'), mv('g2', 'g4'), mv('d8', 'h4')];
    for (const [n, a] of moves.entries()) {
      const s = n % 2 ? guestSession : hostSession;
      expect(await s.act({ game: 1, n, action: a, nonce: `n${n}` })).toEqual({ ok: true, n });
    }
    await until(() => hostEvents.filter((e) => e.type === 'action').length === 4 && guestEvents.filter((e) => e.type === 'action').length === 4);

    // both sides rebuild the same final position, and it matches the server's fingerprint
    const setup = guestState.setup!;
    let g = setupGame(setup);
    for (const e of guestEvents) {
      if (e.type !== 'action') continue;
      const r = applyAction(g, e.action);
      expect(r.ok).toBe(true);
      if (r.ok) g = r.state;
      expect(stateHash(g)).toBe(e.hash);
    }
    expect(g.status).toEqual({ kind: 'checkmate', winner: 'b' });

    // rematch over the wire
    await hostSession.rematch();
    await guestSession.rematch();
    await until(() => guestEvents.filter((e) => e.type === 'start').length === 1);
    expect(guestEvents.find((e) => e.type === 'start')).toMatchObject({ game: 2, hostColor: 'b' });

    // leaving closes the room for the other side
    await guestSession.leave();
    await until(() => hostEvents.some((e) => e.type === 'closed'));
    hostSession.stop();
    guestSession.stop();
  });

  it('Spell-toborzás over the wire: the draft, the picks and the game that follows', async () => {
    const created = await post('/api/rooms', req('Anna', { draft: true, color: 'b' }));
    expect(created.ok).toBe(true);
    const listed = await (await fetch(`${base}/api/rooms`)).json();
    expect(listed.rooms.find((r: { code: string }) => r.code === created.seat.code)).toMatchObject({ draft: true });
    const joined = await post(`/api/rooms/${created.seat.code}/join`, req('Bence'));
    expect(joined.ok).toBe(true);
    const st = joined.state as RoomState;
    expect(st.draft!.pool).toHaveLength(32);
    const host = new OnlineSession(base, created.seat, created.state as RoomState);
    const guest = new OnlineSession(base, joined.seat, st);
    // Anna (host) plays Sötét: Bence (Világos) picks first
    let d = st.draft!;
    for (let i = 0; i < 12; i++) {
      const who: 'w' | 'b' = i % 2 === 0 ? 'w' : 'b';
      const id = d.pool.find((s) => pickBlockReason(d, who, s) === null)!;
      const s = who === 'w' ? guest : host;
      expect(await s.pick({ game: 1, spell: id })).toEqual({ ok: true });
      const now = await s.state();
      if (now.ok && now.state.draft) d = now.state.draft;
      else if (now.ok) {
        expect(now.state.setup!.decks.w).toHaveLength(6);
        expect(now.state.setup!.names).toEqual({ w: 'Bence', b: 'Anna' });
      }
    }
    const fin = await host.state();
    expect(fin.ok && fin.state.setup && fin.state.draft === null).toBe(true);
    await guest.leave();
  });

  it('a room code that does not exist', async () => {
    expect(await post('/api/rooms/ZZZZ/join', req('X'))).toMatchObject({ ok: false });
    const st = await post('/api/rooms/ZZZZ/state', { token: 'x' });
    expect(st.ok).toBe(false);
  });
});

describe('every spell survives the trip', () => {
  it('actions are plain JSON – what goes over the wire comes back the same', () => {
    for (const s of SPELL_LIST) {
      const a: Action = { type: 'CAST', spellId: s.id, targets: [0, 63] };
      expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    }
  });
});
