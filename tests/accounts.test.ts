// The backend's accounts: registering in all three modes, the built-in fail2ban (account lock and
// address ban), sessions, decks on the server, friends, presence, challenges that start a game,
// the control panel's operations, the data file, the proxy-aware client address – and the same
// things over real HTTP.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Action, SpellId } from '../src/engine';
import { AccountApi, AccountSession, login as httpLogin, register as httpRegister } from '../src/net/client';
import { BUILD_ID, replay, type AccountEvent, type MeView } from '../src/net/protocol';
import { Accounts } from '../server/accounts';
import { startBackend, type RunningBackend } from '../server/index';
import { Lobby } from '../server/lobby';
import { clientIp, IP_MAX_FAILS } from '../server/security';
import { Store, type StoredUser } from '../server/store';
import { S } from './helpers';

const DECK: SpellId[] = ['manaMage', 'manaDeposit', 'gambit', 'sacrifice', 'overcharge', 'arcaneSurge'];
const mv = (from: string, to: string): Action => ({ type: 'MOVE', from: S(from), to: S(to) });

function world(mode: 'closed' | 'approval' | 'open' = 'open') {
  const clock = { t: 10_000_000 };
  const now = () => clock.t;
  const store = new Store(null);
  store.data.settings.registration = mode;
  const logs: string[] = [];
  const lobby = new Lobby(() => {}, now, () => store.data.settings.guests);
  const acc = new Accounts(store, lobby, (m) => logs.push(m), now);
  const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
    if (!r.ok) throw new Error((r as unknown as { error: string }).error);
    return r as Extract<T, { ok: true }>;
  };
  /** A signed-in player: the user record, the token, and their event stream. */
  const player = async (name: string, ip = '10.0.0.1') => {
    const r = ok(await acc.register({ name, password: 'titok123' }, ip));
    const user = acc.byName(name)!;
    const events = () => acc.events(user, 0).events;
    return { user, token: r.token!, events };
  };
  return { clock, store, lobby, acc, logs, ok, player };
}

describe('registering', () => {
  it('closed: nobody can register', async () => {
    const w = world('closed');
    expect(await w.acc.register({ name: 'Anna', password: 'titok123' }, '1.1.1.1')).toMatchObject({ ok: false });
  });

  it('approval: the account waits, cannot sign in, the admin lets it in', async () => {
    const w = world('approval');
    expect(await w.acc.register({ name: 'Bence', password: 'titok123' }, '1.1.1.1')).toEqual({ ok: true, status: 'pending' });
    expect(await w.acc.login({ name: 'Bence', password: 'titok123' }, '1.1.1.1')).toMatchObject({ ok: false, error: expect.stringMatching(/jóváhagyásra/) });
    expect(w.acc.approve({ id: w.acc.byName('bence')!.id }).ok).toBe(true);
    expect((await w.acc.login({ name: 'BENCE', password: 'titok123' }, '1.1.1.1')).ok).toBe(true); // names ignore case
  });

  it('open: the account works at once; names are unique and checked', async () => {
    const w = world('open');
    const r = w.ok(await w.acc.register({ name: 'Kovács Bence', password: 'titok123' }, '1.1.1.1'));
    expect(r.status).toBe('active');
    expect(r.me?.user.name).toBe('Kovács Bence');
    expect(await w.acc.register({ name: 'kovács bence', password: 'titok123' }, '1.1.1.1')).toMatchObject({ ok: false, error: 'Ez a név már foglalt.' });
    for (const name of ['ab', 'x'.repeat(21), 'An  na', 'Anna<b>', 'a/b']) expect((await w.acc.register({ name, password: 'titok123' }, '1.1.1.1')).ok).toBe(false);
    expect(w.ok(await w.acc.register({ name: '  Anna ', password: 'titok123' }, '1.1.1.1')).me?.user.name).toBe('Anna'); // spaces around are trimmed
    expect((await w.acc.register({ name: 'Dóra', password: '12345' }, '1.1.1.1')).ok).toBe(false); // too short
    expect((await w.acc.register({ name: 'Ödön_2.0-x', password: '123456' }, '1.1.1.1')).ok).toBe(true);
    expect(w.store.data.users.every((u) => u.pass.startsWith('scrypt$') && !u.pass.includes('titok'))).toBe(true);
  });
});

describe('fail2ban', () => {
  it('five wrong passwords lock the account for ten minutes – even the right password is refused', async () => {
    const w = world();
    await w.player('Anna');
    for (let i = 0; i < 4; i++) expect((await w.acc.login({ name: 'Anna', password: 'rossz' }, `5.5.5.${i}`)).ok).toBe(false);
    const fifth = await w.acc.login({ name: 'Anna', password: 'rossz' }, '5.5.5.9');
    expect(fifth).toMatchObject({ ok: false, error: expect.stringMatching(/10 percre zárolva/) });
    expect(await w.acc.login({ name: 'Anna', password: 'titok123' }, '6.6.6.6')).toMatchObject({ ok: false, error: expect.stringMatching(/zárolva/) });
    expect(w.acc.adminUsers().find((u) => u.name === 'Anna')!.locked).toBeGreaterThan(590);
    w.clock.t += 10 * 60_000 + 1000;
    expect((await w.acc.login({ name: 'Anna', password: 'titok123' }, '6.6.6.6')).ok).toBe(true);
    expect(w.logs.some((l) => /Fiók zárolva/.test(l))).toBe(true);
  });

  it('a right password in between resets the count; the admin can unlock', async () => {
    const w = world();
    await w.player('Anna');
    for (let i = 0; i < 4; i++) await w.acc.login({ name: 'Anna', password: 'rossz' }, '7.7.7.7');
    expect((await w.acc.login({ name: 'Anna', password: 'titok123' }, '7.7.7.7')).ok).toBe(true);
    for (let i = 0; i < 4; i++) await w.acc.login({ name: 'Anna', password: 'rossz' }, '7.7.7.8');
    expect((await w.acc.login({ name: 'Anna', password: 'titok123' }, '7.7.7.8')).ok).toBe(true); // still 4 < 5
    for (let i = 0; i < 5; i++) await w.acc.login({ name: 'Anna', password: 'rossz' }, '7.7.7.9');
    expect((await w.acc.login({ name: 'Anna', password: 'titok123' }, '7.7.7.9')).ok).toBe(false);
    w.acc.unlock({ id: w.acc.byName('Anna')!.id });
    expect((await w.acc.login({ name: 'Anna', password: 'titok123' }, '7.7.7.9')).ok).toBe(true);
  });

  it('an address that keeps guessing is banned from signing in, for everyone, until the ban runs out', async () => {
    const w = world();
    await w.player('Anna');
    await w.player('Bence');
    for (let i = 0; i < IP_MAX_FAILS; i++) await w.acc.login({ name: `nincs${i}`, password: 'x' }, '9.9.9.9');
    expect(await w.acc.login({ name: 'Bence', password: 'titok123' }, '9.9.9.9')).toMatchObject({ ok: false, error: expect.stringMatching(/erről a címről/) });
    expect((await w.acc.register({ name: 'Cecil', password: 'titok123' }, '9.9.9.9')).ok).toBe(false);
    expect((await w.acc.login({ name: 'Bence', password: 'titok123' }, '9.9.9.10')).ok).toBe(true); // other addresses are fine
    expect(w.store.data.bans).toEqual([expect.objectContaining({ ip: '9.9.9.9' })]);
    w.clock.t += 10 * 60_000 + 1;
    w.acc.tick();
    expect((await w.acc.login({ name: 'Bence', password: 'titok123' }, '9.9.9.9')).ok).toBe(true);
    // unbanning by hand
    for (let i = 0; i < IP_MAX_FAILS; i++) await w.acc.login({ name: 'x', password: 'x' }, '8.8.8.8');
    expect(w.acc.guard.banned('8.8.8.8')).toBeGreaterThan(0);
    expect(w.acc.guard.unban('8.8.8.8')).toBe(true);
    expect((await w.acc.login({ name: 'Anna', password: 'titok123' }, '8.8.8.8')).ok).toBe(true);
  });

  it('the thresholds come from the settings', async () => {
    const w = world();
    await w.player('Anna');
    expect(w.acc.updateSettings({ maxFails: 3, lockMinutes: 2 }).ok).toBe(true);
    for (let i = 0; i < 3; i++) await w.acc.login({ name: 'Anna', password: 'rossz' }, '4.4.4.4');
    expect((await w.acc.login({ name: 'Anna', password: 'titok123' }, '4.4.4.4')).ok).toBe(false);
    w.clock.t += 2 * 60_000 + 1;
    expect((await w.acc.login({ name: 'Anna', password: 'titok123' }, '4.4.4.4')).ok).toBe(true);
    expect(w.acc.updateSettings({ maxFails: 1 }).ok).toBe(false);
    expect(w.acc.updateSettings({ registration: 'nyitva' }).ok).toBe(false);
  });
});

describe('sessions and passwords', () => {
  it('a token signs in; logging out ends it; a changed password ends the other sessions', async () => {
    const w = world();
    const a = await w.player('Anna');
    expect(w.acc.session(a.token)?.name).toBe('Anna');
    const second = w.ok(await w.acc.login({ name: 'Anna', password: 'titok123' }, '1.2.3.4')).token;
    expect((await w.acc.changePassword(a.user, { old: 'rossz', password: 'ujjelszo1' }, '1.2.3.4', a.token)).ok).toBe(false);
    expect((await w.acc.changePassword(a.user, { old: 'titok123', password: 'ujjelszo1' }, '1.2.3.4', a.token)).ok).toBe(true);
    expect(w.acc.session(a.token)).not.toBeNull();
    expect(w.acc.session(second)).toBeNull();
    w.acc.logout(a.token);
    expect(w.acc.session(a.token)).toBeNull();
    expect((await w.acc.login({ name: 'Anna', password: 'ujjelszo1' }, '1.2.3.4')).ok).toBe(true);
    // a session unused for a month ends
    const t3 = w.ok(await w.acc.login({ name: 'Anna', password: 'ujjelszo1' }, '1.2.3.4')).token;
    w.clock.t += 31 * 24 * 60 * 60_000;
    expect(w.acc.session(t3)).toBeNull();
  });

  it('the admin sets a new password: every session ends and the stream says so', async () => {
    const w = world();
    const a = await w.player('Anna');
    expect((await w.acc.setPassword({ id: a.user.id, password: 'uj123456' })).ok).toBe(true);
    expect(w.acc.session(a.token)).toBeNull();
    expect(a.events().at(-1)).toMatchObject({ type: 'signedOut' });
  });
});

describe('decks on the server', () => {
  it('saves, updates, validates and deletes', async () => {
    const w = world();
    const a = await w.player('Anna');
    expect(w.acc.saveDeck(a.user, { deck: { id: 'd1', name: 'Első', description: 'x', spells: DECK } }).ok).toBe(true);
    expect(w.acc.saveDeck(a.user, { deck: { id: 'd1', name: 'Átnevezve', description: '', spells: DECK } }).ok).toBe(true);
    expect(a.user.decks).toHaveLength(1);
    expect(a.user.decks[0].name).toBe('Átnevezve');
    expect(w.acc.saveDeck(a.user, { deck: { id: 'd2', name: 'Két hatos', spells: ['meteor', 'dragonFire', ...DECK.slice(2)] } }).ok).toBe(false);
    expect(w.acc.saveDeck(a.user, { deck: { id: 'd3', name: 'Hamis', spells: ['__proto__', ...DECK.slice(1)] } }).ok).toBe(false);
    expect(w.acc.saveDeck(a.user, { deck: { id: '../x', name: 'Rossz id', spells: DECK } }).ok).toBe(false);
    for (let i = 2; i <= 30; i++) expect(w.acc.saveDeck(a.user, { deck: { id: `d${i}`, name: `P${i}`, spells: DECK } }).ok).toBe(true);
    expect(w.acc.saveDeck(a.user, { deck: { id: 'd31', name: 'Túl sok', spells: DECK } }).ok).toBe(false);
    expect(w.acc.deleteDeck(a.user, { id: 'd1' }).ok).toBe(true);
    expect(w.acc.deleteDeck(a.user, { id: 'd1' }).ok).toBe(false);
    expect(w.acc.me(a.user).decks).toHaveLength(29);
  });
});

describe('friends', () => {
  it('search, request, accept – with notices on the other side', async () => {
    const w = world();
    const a = await w.player('Anna');
    const b = await w.player('Bence');
    await w.acc.register({ name: 'Benedek', password: 'titok123' }, '1.1.1.1');
    const hits = w.ok(w.acc.search(a.user, { q: 'ben' })).users;
    expect(hits.map((h) => h.name)).toEqual(['Bence', 'Benedek']);
    expect(w.ok(w.acc.search(a.user, { q: 'a' })).users).toEqual([]); // two letters at least
    expect(w.acc.request(a.user, { id: b.user.id }).ok).toBe(true);
    expect(b.events().at(-1)).toMatchObject({ type: 'refresh', notice: 'Anna barátnak jelölt.' });
    expect(w.acc.me(b.user).requestsIn).toEqual([{ id: a.user.id, name: 'Anna' }]);
    expect(w.ok(w.acc.search(a.user, { q: 'bence' })).users[0].relation).toBe('asked');
    expect(w.acc.accept(b.user, { id: a.user.id }).ok).toBe(true);
    expect(a.events().at(-1)).toMatchObject({ notice: expect.stringMatching(/Bence elfogadta/) });
    expect(w.acc.me(a.user).friends.map((f) => f.name)).toEqual(['Bence']);
    expect(w.acc.request(a.user, { id: b.user.id })).toMatchObject({ ok: false, error: 'Már barátok vagytok.' });
    expect(w.acc.request(a.user, { id: a.user.id }).ok).toBe(false);
    expect(w.acc.unfriend(b.user, { id: a.user.id }).ok).toBe(true);
    expect(a.user.friends).toEqual([]);
  });

  it('asking someone who already asked you makes you friends; decline and cancel', async () => {
    const w = world();
    const a = await w.player('Anna');
    const b = await w.player('Bence');
    const c = await w.player('Csaba');
    w.acc.request(a.user, { id: b.user.id });
    expect(w.acc.request(b.user, { name: 'anna' }).ok).toBe(true);
    expect(a.user.friends).toEqual([b.user.id]);
    w.acc.request(c.user, { id: a.user.id });
    expect(w.acc.decline(a.user, { id: c.user.id }).ok).toBe(true);
    expect(c.user.requestsOut).toEqual([]);
    w.acc.request(c.user, { id: a.user.id });
    expect(w.acc.cancelRequest(c.user, { id: a.user.id }).ok).toBe(true);
    expect(a.user.requestsIn).toEqual([]);
  });

  it('presence: online while the stream is polled, playing at a board, offline when gone', async () => {
    const w = world();
    const a = await w.player('Anna');
    const b = await w.player('Bence');
    w.acc.request(a.user, { id: b.user.id });
    w.acc.accept(b.user, { id: a.user.id });
    expect(w.acc.presenceOf(b.user.id)).toBe('offline');
    w.acc.events(a.user, 0); // Anna's page is listening
    w.acc.polling(b.user.id, true);
    expect(w.acc.presenceOf(b.user.id)).toBe('online');
    w.acc.tick();
    expect(a.events().filter((e) => e.type === 'presence').at(-1)).toMatchObject({ userId: b.user.id, status: 'online' });
    w.acc.polling(b.user.id, false);
    w.clock.t += 31_000;
    w.acc.tick();
    expect(a.events().filter((e) => e.type === 'presence').at(-1)).toMatchObject({ status: 'offline' });
  });
});

describe('challenges', () => {
  async function friends() {
    const w = world();
    const a = await w.player('Anna');
    const b = await w.player('Bence');
    w.acc.request(a.user, { id: b.user.id });
    w.acc.accept(b.user, { id: a.user.id });
    w.acc.polling(b.user.id, true); // Bence is online
    w.acc.polling(a.user.id, true);
    return { w, a, b };
  }

  it('accepted: both get a seat in a started game and can play it', async () => {
    const { w, a, b } = await friends();
    const c = w.ok(w.acc.challenge(a.user, { to: b.user.id, deck: DECK, deckName: 'Mana', color: 'w', autoEndTurn: true, build: BUILD_ID })).challenge;
    expect(w.acc.me(b.user).challengesIn).toEqual([expect.objectContaining({ id: c.id, from: { id: a.user.id, name: 'Anna' }, color: 'w' })]);
    expect(b.events().at(-1)).toMatchObject({ notice: 'Anna kihívott egy játszmára!' });
    const r = w.ok(w.acc.acceptChallenge(b.user, { id: c.id, deck: DECK, deckName: 'Bence paklija', build: BUILD_ID }));
    const hostSeat = a.events().find((e): e is Extract<AccountEvent, { type: 'game' }> => e.type === 'game')!;
    expect(hostSeat.seat.code).toBe(r.seat.code);
    expect(r.state.setup!.names).toEqual({ w: 'Anna', b: 'Bence' });
    // the game runs on the lobby like any other
    expect(w.lobby.act(r.seat.code, { token: hostSeat.seat.token, game: 1, n: 0, action: mv('e2', 'e4'), nonce: 'x' }).ok).toBe(true);
    expect(w.lobby.act(r.seat.code, { token: r.seat.token, game: 1, n: 1, action: mv('e7', 'e5'), nonce: 'y' }).ok).toBe(true);
    const st = w.lobby.state(r.seat.code, r.seat.token);
    expect(st.ok && replay(st.state.setup!, st.state.actions).moveList).toHaveLength(2);
    expect(w.acc.me(a.user).games).toEqual([expect.objectContaining({ code: r.seat.code, role: 'host', opponent: 'Bence', running: true })]);
    expect(w.acc.presenceOf(a.user.id)).toBe('playing');
    expect(w.acc.me(b.user).challengesIn).toEqual([]);
  });

  it('only friends, only online ones; decline, cancel and expiry', async () => {
    const { w, a, b } = await friends();
    const c = await w.player('Csaba');
    const send = (from: StoredUser, to: StoredUser) => w.acc.challenge(from, { to: to.id, deck: DECK, deckName: 'M', color: 'random', build: BUILD_ID });
    expect(send(a.user, c.user).ok).toBe(false); // not a friend
    w.acc.polling(b.user.id, false);
    w.clock.t += 31_000;
    expect(send(a.user, b.user)).toMatchObject({ ok: false, error: expect.stringMatching(/nincs bejelentkezve/) });
    w.acc.polling(b.user.id, true);
    const c1 = w.ok(send(a.user, b.user)).challenge;
    expect(w.acc.declineChallenge(b.user, { id: c1.id }).ok).toBe(true);
    expect(a.events().at(-1)).toMatchObject({ notice: expect.stringMatching(/nem fogadta el/) });
    const c2 = w.ok(send(a.user, b.user)).challenge;
    expect(w.acc.cancelChallenge(a.user, { id: c2.id }).ok).toBe(true);
    expect(w.acc.acceptChallenge(b.user, { id: c2.id, deck: DECK, deckName: 'x', build: BUILD_ID }).ok).toBe(false);
    const c3 = w.ok(send(a.user, b.user)).challenge;
    w.clock.t += 5 * 60_000 + 1;
    w.acc.tick();
    expect(w.acc.acceptChallenge(b.user, { id: c3.id, deck: DECK, deckName: 'x', build: BUILD_ID }).ok).toBe(false);
    expect(a.events().some((e) => e.type === 'refresh' && /lejárt/.test(e.notice ?? ''))).toBe(true);
  });
});

describe('rooms and accounts', () => {
  it('guests can be switched off; signed-in players still play, under their account name', async () => {
    const w = world();
    const a = await w.player('Anna');
    w.store.data.settings.guests = false;
    const room = { name: 'Ál-név', deck: DECK, deckName: 'M', color: 'w', autoEndTurn: true, build: BUILD_ID };
    expect(w.lobby.create(room)).toMatchObject({ ok: false, error: expect.stringMatching(/bejelentkezve/) });
    const r = w.ok(w.lobby.create(room, { id: a.user.id, name: 'Anna' }));
    expect(r.state.names.host).toBe('Anna');
    expect(w.lobby.list()).toEqual([expect.objectContaining({ host: 'Anna', guest: false })]);
    expect(w.lobby.join(r.seat.code, room, { id: a.user.id, name: 'Anna' }).ok).toBe(false); // not your own room
    expect(w.lobby.join(r.seat.code, room).ok).toBe(false); // guests are off
    w.store.data.settings.guests = true;
    expect(w.lobby.join(r.seat.code, { ...room, name: 'Vendég Viki' }).ok).toBe(true);
  });

  it("a member's list of games stays current: opening, starting and closing a room refresh their lobby", async () => {
    const w = world();
    const a = await w.player('Anna');
    const refreshes = () => a.events().filter((e) => e.type === 'refresh').length;
    const room = { name: '', deck: DECK, deckName: 'M', color: 'w', autoEndTurn: true, build: BUILD_ID };
    const before = refreshes();
    const r = w.ok(w.lobby.create(room, { id: a.user.id, name: 'Anna' }));
    expect(refreshes()).toBe(before + 1);
    expect(w.acc.me(a.user).games).toEqual([expect.objectContaining({ code: r.seat.code, game: 0, running: false })]);
    w.ok(w.lobby.join(r.seat.code, { ...room, name: 'Vendég Viki' }));
    expect(refreshes()).toBe(before + 2);
    expect(w.acc.me(a.user).games[0]).toMatchObject({ game: 1, running: true, opponent: 'Vendég Viki' });
    w.ok(w.lobby.leave(r.seat.code, r.seat.token));
    expect(refreshes()).toBeGreaterThanOrEqual(before + 3);
    expect(w.acc.me(a.user).games).toEqual([]);
  });
});

describe('the control panel', () => {
  it('the first admin needs the setup code from the server window', async () => {
    const w = world();
    expect(w.acc.setupCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(await w.acc.setup({ code: 'ROSSZ-KOD', name: 'Admin', password: 'admin123' }, '2.2.2.2')).toMatchObject({ ok: false });
    const r = w.ok(await w.acc.setup({ code: w.acc.setupCode, name: 'Admin', password: 'admin123' }, '2.2.2.2'));
    expect(r.me.user.role).toBe('admin');
    expect(w.acc.setupCode).toBeNull();
    expect((await w.acc.setup({ code: 'x', name: 'Más', password: 'admin123' }, '2.2.2.2')).ok).toBe(false);
    // a new code (--setup) lets an existing account become admin again with a new password
    const code = w.acc.newSetupCode();
    expect((await w.acc.setup({ code, name: 'admin', password: 'masik123' }, '2.2.2.2')).ok).toBe(true);
    expect((await w.acc.login({ name: 'Admin', password: 'masik123' }, '2.2.2.2')).ok).toBe(true);
  });

  it('creates, promotes, protects the last admin, and removes accounts with everything they had', async () => {
    const w = world();
    const admin = w.ok(await w.acc.setup({ code: w.acc.setupCode, name: 'Admin', password: 'admin123' }, '1.1.1.1'));
    const adminUser = w.acc.byId(admin.me.user.id)!;
    const made = w.ok(await w.acc.adminCreate({ name: 'Kézi Károly', password: 'titok123' }));
    expect(made.user).toMatchObject({ name: 'Kézi Károly', status: 'active', role: 'user' });
    expect(w.acc.setRole(adminUser, { id: adminUser.id, role: 'user' }).ok).toBe(false); // not yourself
    expect(w.acc.setRole(adminUser, { id: made.user.id, role: 'admin' }).ok).toBe(true);
    expect(w.acc.setRole(adminUser, { id: made.user.id, role: 'user' }).ok).toBe(true);
    expect(w.acc.remove(adminUser, { id: adminUser.id }).ok).toBe(false);
    // removal cleans up: friendship, challenge, the running game
    const a = await w.player('Anna');
    const k = w.acc.byId(made.user.id)!;
    w.acc.request(a.user, { id: k.id });
    w.acc.accept(k, { id: a.user.id });
    w.acc.polling(k.id, true);
    w.acc.polling(a.user.id, true);
    const room = w.ok(w.lobby.create({ deck: DECK, deckName: 'M', color: 'w', build: BUILD_ID }, { id: k.id, name: k.name }));
    w.lobby.join(room.seat.code, { name: 'Vendég', deck: DECK, deckName: 'M', build: BUILD_ID });
    w.ok(w.acc.challenge(k, { to: a.user.id, deck: DECK, deckName: 'M', build: BUILD_ID }));
    expect(w.acc.remove(adminUser, { id: k.id }).ok).toBe(true);
    expect(w.acc.byId(k.id)).toBeUndefined();
    expect(a.user.friends).toEqual([]);
    expect(w.acc.me(a.user).challengesIn).toEqual([]);
    const st = w.lobby.state(room.seat.code, room.seat.token);
    expect(st.ok && st.state.closed).toBeTruthy();
    expect(w.acc.adminUsers().map((u) => u.name)).toEqual(['Admin', 'Anna']);
  });
});

describe('the data file', () => {
  it('survives a restart, is written atomically, and a broken file is set aside', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mana-'));
    const file = join(dir, 'data.json');
    try {
      const s1 = new Store(file);
      const lobby = new Lobby();
      const acc = new Accounts(s1, lobby);
      s1.data.settings.registration = 'open';
      const r = await acc.register({ name: 'Anna', password: 'titok123' }, '1.1.1.1');
      acc.saveDeck(acc.byName('Anna')!, { deck: { id: 'd1', name: 'P', spells: DECK } });
      s1.flush();
      expect(existsSync(`${file}.tmp`)).toBe(false);
      const raw = readFileSync(file, 'utf8');
      expect(raw).not.toContain('titok123');
      expect(raw).not.toContain(r.ok ? r.token! : '???'); // only a hash of the session is kept
      const s2 = new Store(file);
      const acc2 = new Accounts(s2, new Lobby());
      expect(acc2.session(r.ok ? r.token : '')?.name).toBe('Anna');
      expect(acc2.byName('anna')!.decks).toHaveLength(1);
      writeFileSync(file, '{ nem json');
      const s3 = new Store(file);
      expect(s3.data.users).toEqual([]);
      expect(readdirSync(dir).some((f) => f.includes('.broken-'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a file it may not read (e.g. a backup put back as root) stops the start – it never starts empty over it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mana-'));
    const file = join(dir, 'data.json');
    try {
      // a folder where the file should be: unreadable as a file even for root (a mode-000 file is not)
      mkdirSync(file);
      expect(() => new Store(file)).toThrow(/nem olvasható/);
      await expect(startBackend({ port: 0, host: '127.0.0.1', dataFile: file })).rejects.toMatchObject({ code: 'MANA_DATA_UNREADABLE' });
      expect(readdirSync(dir)).toEqual(['data.json']); // nothing set aside, nothing written
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the client address behind a proxy', () => {
  const req = (peer: string, h: Record<string, string> = {}) => ({ socket: { remoteAddress: peer }, headers: h }) as never;
  it('believes X-Real-IP / X-Forwarded-For only from a local proxy (auto)', () => {
    expect(clientIp(req('::ffff:172.18.0.5', { 'x-real-ip': '203.0.113.9' }), 'auto')).toBe('203.0.113.9');
    expect(clientIp(req('127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), 'auto')).toBe('203.0.113.9');
    expect(clientIp(req('198.51.100.7', { 'x-real-ip': '1.2.3.4' }), 'auto')).toBe('198.51.100.7'); // a forged header from outside
    expect(clientIp(req('198.51.100.7', { 'x-real-ip': '1.2.3.4' }), 'always')).toBe('1.2.3.4');
    expect(clientIp(req('10.0.0.2', { 'x-real-ip': '1.2.3.4' }), 'never')).toBe('10.0.0.2');
  });
});

describe('over HTTP', () => {
  let srv: RunningBackend;
  let base = '';
  let panel = '';
  beforeAll(async () => {
    srv = await startBackend({ port: 0, host: '127.0.0.1', adminPort: 0, adminHost: '127.0.0.1', dataFile: null });
    srv.store.data.settings.registration = 'open';
    base = `http://127.0.0.1:${srv.port}`;
    panel = `http://127.0.0.1:${srv.adminPort}`;
  });
  afterAll(() => srv.close());
  const post = (path: string, body: unknown, at = base) => fetch(at + path, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) }).then((r) => r.json());

  it('the control panel lives on its own port only, with a strict CSP and no CORS', async () => {
    expect(srv.adminPort).not.toBe(srv.port);
    const admin = await fetch(`${panel}/admin`);
    const csp = admin.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/script-src 'nonce-/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    const html = await admin.text();
    const nonce = /nonce-([^']+)'/.exec(csp)![1];
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain('function adminApp');
    expect((await fetch(`${panel}/`)).status).toBe(200); // the panel's own root is the panel
    const status = await fetch(`${panel}/api/admin/status`, { method: 'POST', body: '{}' });
    expect(status.headers.get('access-control-allow-origin')).toBeNull();
    expect(await status.json()).toMatchObject({ ok: true, setup: true });
    expect(await post('/api/admin/overview', { token: 'nincs-ilyen-token-nincs' }, panel)).toMatchObject({ ok: false, auth: false });
    // nothing of it on the backend's port – the one that goes on the internet
    const landing = await fetch(`${base}/`);
    expect(landing.status).toBe(200);
    expect(await landing.text()).not.toContain('/admin');
    expect((await fetch(`${base}/admin`)).status).toBe(404);
    for (const p of ['/api/admin/status', '/api/admin/setup', '/api/admin/overview', '/api/admin/users/delete']) {
      const r = await fetch(base + p, { method: 'POST', body: '{}' });
      expect(r.status).toBe(404);
    }
  });

  it('the control panel lets only admins sign in', async () => {
    const code = srv.accounts.setupCode!;
    const made = await post('/api/admin/setup', { code, name: 'Gazda', password: 'gazda123' }, panel);
    expect(made.ok).toBe(true);
    expect((await post('/api/auth/login', { name: 'Gazda', password: 'gazda123' }, panel)).ok).toBe(true);
    await httpRegister(base, 'Jatekos', 'titok123');
    const player = await post('/api/auth/login', { name: 'Jatekos', password: 'titok123' }, panel);
    expect(player).toMatchObject({ ok: false, error: expect.stringMatching(/nem adminisztrátor/) });
    // the player's own session (from the game) is no key to the panel either
    const own = await httpLogin(base, 'Jatekos', 'titok123');
    expect(own.ok).toBe(true);
    expect(await post('/api/admin/overview', { token: own.ok ? own.token : '' }, panel)).toMatchObject({ ok: false, error: expect.stringMatching(/adminisztrátori jog/) });
    // the admin's calls work on the panel's port
    const admin = await post('/api/auth/login', { name: 'Gazda', password: 'gazda123' }, panel);
    expect((await post('/api/admin/overview', { token: admin.token }, panel)).ok).toBe(true);
  });

  it('register, sign in, friends and a challenge through the client classes and the live stream', async () => {
    const r1 = await httpRegister(base, 'Anna', 'titok123');
    const r2 = await httpRegister(base, 'Bence', 'titok123');
    if (!r1.ok || !r2.ok) throw new Error('register');
    const anna = new AccountApi(base, r1.token!);
    const bence = new AccountApi(base, r2.token!);
    const stream = new AccountSession(base, r2.token!, r2.last ?? 0);
    const got: AccountEvent[] = [];
    stream.subscribe((e) => got.push(e));
    stream.start();
    await new Promise((ok) => setTimeout(ok, 120));
    const hits = await anna.search('ben');
    expect(hits.ok && hits.users.map((u) => u.name)).toEqual(['Bence']);
    expect((await anna.request(r2.me!.user.id)).ok).toBe(true);
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 100 && !cond(); i++) await new Promise((ok) => setTimeout(ok, 20));
      expect(cond()).toBe(true);
    };
    await until(() => got.some((e) => e.type === 'refresh' && e.notice === 'Anna barátnak jelölt.'));
    expect((await bence.accept(r1.me!.user.id)).ok).toBe(true);
    const annaStream = new AccountSession(base, r1.token!, 0);
    const annaGot: AccountEvent[] = [];
    annaStream.subscribe((e) => annaGot.push(e));
    annaStream.start();
    await new Promise((ok) => setTimeout(ok, 120));
    const sent = await anna.challenge(r2.me!.user.id, DECK, 'Mana', 'b', true);
    expect(sent.ok).toBe(true);
    const me = (await bence.me()) as { ok: true; me: MeView };
    const accepted = await bence.acceptChallenge(me.me.challengesIn[0].id, DECK, 'B');
    expect(accepted.ok && accepted.state.setup!.names).toEqual({ w: 'Bence', b: 'Anna' });
    await until(() => annaGot.some((e) => e.type === 'game'));
    // deck on the server, then a login elsewhere sees it
    expect((await anna.saveDeck({ id: 'pakli-1', name: 'Szerveres', description: '', spells: DECK })).ok).toBe(true);
    const again = await httpLogin(base, 'anna', 'titok123');
    expect(again.ok && again.me.decks.map((d) => d.name)).toEqual(['Szerveres']);
    // signing out ends the stream on the other device with a signedOut event
    await srv.accounts.setPassword({ id: r2.me!.user.id, password: 'uj123456' });
    await until(() => got.some((e) => e.type === 'signedOut'));
    stream.stop();
    annaStream.stop();
  });

  it('five wrong passwords over HTTP lock the account', async () => {
    await httpRegister(base, 'Cecil', 'titok123');
    for (let i = 0; i < 5; i++) await httpLogin(base, 'Cecil', 'rossz');
    const r = await httpLogin(base, 'Cecil', 'titok123');
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/zárolva/) });
  });
});
