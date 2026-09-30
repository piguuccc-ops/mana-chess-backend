// ─────────────────────────────────────────────────────────────────────────────
// Mana Chess backend: accounts, decks, friends, challenges, the rooms (lobby.ts) and the web
// control panel. Plain HTTP – put it behind Nginx Proxy Manager (or any reverse proxy) for
// HTTPS; the client's real address is then read from X-Real-IP / X-Forwarded-For. The game
// page itself is served by the separate frontend server (frontend.ts) or opened from a file.
// No packages needed; the command line lives in main.ts.
//
//   GET  /                         a short page: what this is, the control panel link
//   GET  /admin                    the control panel
//   GET  /api/info                 name, version, registration mode, guest play
//   GET  /api/rooms                open rooms
//   POST /api/rooms                open a room                 {auth?, name, deck, …}
//   POST /api/rooms/:code/(join|state|poll|action|draw|rematch|leave)
//   POST /api/auth/(register|login|logout)
//   POST /api/me, /api/me/poll, /api/me/password
//   POST /api/decks/(save|delete)
//   POST /api/friends/(search|request|accept|decline|cancel|remove)
//   POST /api/challenges/(send|accept|decline|cancel)
//   POST /api/admin/…              the control panel's calls (admin accounts only)
//
// Requests are JSON sent as text/plain and the session token travels in the body, so a page
// from any address (or a file) talks to the server without CORS preflights or cookies.
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { BUILD_ID, POLL_WAIT_MS, type DrawAnswer, type ServerInfo } from '../src/net/protocol';
import { Accounts } from './accounts';
import { adminPage, landingPage } from './pages';
import { Lobby, type Member } from './lobby';
import { clientIp, RateLimit } from './security';
import { Store } from './store';

export interface BackendOptions {
  port: number;
  /** Tries the next ports when the first one is taken. */
  portTries?: number;
  host?: string;
  /**
   * The address(es) players use to reach this server, when the machine's own addresses mean
   * nothing to them (in a Docker container, behind a proxy): shown in the control panel and the log.
   */
  publicUrls?: string[];
  /** Don't offer this machine's own addresses (a container's are Docker-internal, useless to players). */
  hideLanAddresses?: boolean;
  /** The data file (null: nothing is written – tests). */
  dataFile?: string | null;
  log?: (msg: string) => void;
  now?: () => number;
}

export interface RunningBackend {
  server: Server;
  lobby: Lobby;
  accounts: Accounts;
  store: Store;
  port: number;
  /** http://… addresses on this machine's network interfaces (LAN first). */
  lanUrls: string[];
  close(): Promise<void>;
}

const MAX_BODY = 64 * 1024;

/** IPv4 addresses of this machine that others on the network can reach, the likely LAN one first. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      const v4 = a.family === 'IPv4' || (a.family as unknown) === 4;
      if (!v4 || a.internal || a.address.startsWith('169.254.')) continue;
      out.push(a.address);
    }
  }
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return [...new Set(out)].sort((a, b) => rank(a) - rank(b));
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(status, headers({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text)) }));
  res.end(text);
}

function sendPage(res: ServerResponse, html: string, nonce: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  });
  res.end(html);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('A kérés túl nagy.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        resolve(typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
      } catch {
        reject(new Error('Érvénytelen JSON.'));
      }
    });
    req.on('error', reject);
  });
}

const NO_AUTH = { ok: false, error: 'A bejelentkezés lejárt – lépj be újra.', auth: false };

export function startBackend(opts: BackendOptions): Promise<RunningBackend> {
  const now = opts.now ?? (() => Date.now());
  const logLines: string[] = [];
  const log = (msg: string) => {
    const t = new Date(now()).toLocaleString('hu-HU', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    logLines.push(`${t}  ${msg}`);
    if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
    opts.log?.(msg);
  };
  let store: Store;
  try {
    store = new Store(opts.dataFile ?? null, log);
  } catch (e) {
    return Promise.reject(e); // an unreadable data file: the caller says what to do
  }
  const lobby = new Lobby(log, now, () => store.data.settings.guests);
  const accounts = new Accounts(store, lobby, log, now);
  /** Everything from one address (long polls included – generous). */
  const requests = new RateLimit(1200, 60_000, now);
  /** New accounts from one address. */
  const registrations = new RateLimit(5, 60 * 60_000, now);
  const started = now();
  let port = opts.port;
  /** Where players reach this server (the configured public address, or this machine's LAN addresses). */
  const reachable = () =>
    opts.publicUrls?.length ? [...opts.publicUrls] : opts.hideLanAddresses ? [] : lanAddresses().map((ip) => `http://${ip}:${port}`);

  const info = (): ServerInfo => ({
    app: 'mana-chess',
    build: BUILD_ID,
    name: store.data.settings.serverName,
    registration: store.data.settings.registration,
    guests: store.data.settings.guests,
    addresses: reachable(),
    rooms: lobby.openRooms,
  });

  /** The signed-in player behind `auth` (undefined: no token given, null: a token that is no good). */
  const memberOf = (auth: unknown): Member | null | undefined => {
    if (auth === undefined || auth === null || auth === '') return undefined;
    const u = accounts.session(auth);
    return u ? { id: u.id, name: u.name } : null;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    const ip = clientIp(req, store.data.settings.trustProxy);

    if (method === 'OPTIONS') {
      const extra: Record<string, string> = req.headers['access-control-request-private-network'] ? { 'Access-Control-Allow-Private-Network': 'true' } : {};
      res.writeHead(204, headers(extra));
      res.end();
      return;
    }
    if (!requests.take(ip)) return send(res, 429, { ok: false, error: 'Túl sok kérés – lassíts egy kicsit.' });

    if (method === 'GET') {
      if (path === '/' || path === '/admin') {
        const nonce = randomBytes(12).toString('base64');
        return sendPage(res, path === '/' ? landingPage(nonce, info()) : adminPage(nonce), nonce);
      }
      if (path === '/favicon.ico') {
        res.writeHead(204, headers());
        res.end();
        return;
      }
      if (path === '/api/info') return send(res, 200, info());
      if (path === '/api/rooms') return send(res, 200, { ok: true, rooms: lobby.list() });
      return send(res, 404, { ok: false, error: 'Nincs ilyen cím.' });
    }
    if (method !== 'POST') return send(res, 405, { ok: false, error: 'Nem támogatott kérés.' });
    const body = await readBody(req);

    // ── rooms (guests and signed-in players) ──
    if (path === '/api/rooms') {
      const m = memberOf(body.auth);
      return send(res, 200, m === null ? NO_AUTH : lobby.create(body, m ?? null));
    }
    const room = /^\/api\/rooms\/([A-Za-z]{4})\/(join|state|poll|action|draw|rematch|leave)$/.exec(path);
    if (room) {
      const [, code, verb] = room;
      const tok = typeof body.token === 'string' ? body.token : '';
      switch (verb) {
        case 'join': {
          const m = memberOf(body.auth);
          return send(res, 200, m === null ? NO_AUTH : lobby.join(code, body, m ?? null));
        }
        case 'state':
          return send(res, 200, lobby.state(code, tok));
        case 'poll':
          return roomPoll(code, tok, Number(body.after) || 0, res);
        case 'action':
          return send(res, 200, lobby.act(code, body));
        case 'draw': {
          const answer = body.answer;
          if (answer !== 'offer' && answer !== 'accept' && answer !== 'decline') return send(res, 400, { ok: false, error: 'Érvénytelen válasz.' });
          return send(res, 200, lobby.draw(code, tok, answer as DrawAnswer));
        }
        case 'rematch':
          return send(res, 200, lobby.rematch(code, tok));
        case 'leave':
          return send(res, 200, lobby.leave(code, tok));
      }
    }

    // ── signing in ──
    switch (path) {
      case '/api/auth/register':
        if (!registrations.take(ip)) return send(res, 200, { ok: false, error: 'Erről a címről most túl sok regisztráció érkezett – próbáld később.' });
        return send(res, 200, await accounts.register(body, ip));
      case '/api/auth/login':
        return send(res, 200, await accounts.login(body, ip));
      case '/api/auth/logout':
        return send(res, 200, accounts.logout(body.token));
      case '/api/admin/setup':
        return send(res, 200, await accounts.setup(body, ip));
      case '/api/admin/status':
        // the control panel's first question: set up an admin, or sign in?
        return send(res, 200, { ok: true, setup: !!accounts.setupCode, recovery: !!accounts.setupCode && accounts.hasAdmin(), name: store.data.settings.serverName });
    }

    // ── everything else needs a session ──
    const user = accounts.session(body.token);
    if (!user) return send(res, 200, NO_AUTH);
    const token = body.token as string;
    switch (path) {
      case '/api/me':
        return send(res, 200, { ok: true, me: accounts.me(user), last: accounts.lastEvent(user.id) });
      case '/api/me/poll':
        return accountPoll(user.id, Number(body.after) || 0, res);
      case '/api/me/password':
        return send(res, 200, await accounts.changePassword(user, body, ip, token));
      case '/api/decks/save':
        return send(res, 200, accounts.saveDeck(user, body));
      case '/api/decks/delete':
        return send(res, 200, accounts.deleteDeck(user, body));
      case '/api/friends/search':
        return send(res, 200, accounts.search(user, body));
      case '/api/friends/request':
        return send(res, 200, accounts.request(user, body));
      case '/api/friends/accept':
        return send(res, 200, accounts.accept(user, body));
      case '/api/friends/decline':
        return send(res, 200, accounts.decline(user, body));
      case '/api/friends/cancel':
        return send(res, 200, accounts.cancelRequest(user, body));
      case '/api/friends/remove':
        return send(res, 200, accounts.unfriend(user, body));
      case '/api/challenges/send':
        return send(res, 200, accounts.challenge(user, body));
      case '/api/challenges/accept':
        return send(res, 200, accounts.acceptChallenge(user, body));
      case '/api/challenges/decline':
        return send(res, 200, accounts.declineChallenge(user, body));
      case '/api/challenges/cancel':
        return send(res, 200, accounts.cancelChallenge(user, body));
    }

    // ── the control panel ──
    if (path.startsWith('/api/admin/')) {
      if (user.role !== 'admin') return send(res, 200, { ok: false, error: 'Ehhez adminisztrátori jog kell.' });
      switch (path) {
        case '/api/admin/overview':
          return send(res, 200, {
            ok: true,
            me: { id: user.id, name: user.name },
            settings: store.data.settings,
            stats: { ...accounts.stats(), rooms: lobby.openRooms, uptime: Math.round((now() - started) / 1000) },
            users: accounts.adminUsers(),
            rooms: lobby.overview(),
            bans: store.data.bans.filter((b) => b.until > now()).map((b) => ({ ...b, left: Math.ceil((b.until - now()) / 1000) })),
            log: logLines.slice(-200),
            build: BUILD_ID,
            addresses: info().addresses,
          });
        case '/api/admin/settings':
          return send(res, 200, accounts.updateSettings(body));
        case '/api/admin/users/create':
          return send(res, 200, await accounts.adminCreate(body));
        case '/api/admin/users/approve':
          return send(res, 200, accounts.approve(body));
        case '/api/admin/users/delete':
          return send(res, 200, accounts.remove(user, body));
        case '/api/admin/users/unlock':
          return send(res, 200, accounts.unlock(body));
        case '/api/admin/users/password':
          return send(res, 200, await accounts.setPassword(body));
        case '/api/admin/users/role':
          return send(res, 200, accounts.setRole(user, body));
        case '/api/admin/users/signout':
          return send(res, 200, accounts.signOutEverywhere(body));
        case '/api/admin/bans/remove': {
          const ipToFree = typeof body.ip === 'string' ? body.ip : '';
          const freed = accounts.guard.unban(ipToFree);
          if (freed) log(`Kitiltás feloldva: ${ipToFree}`);
          return send(res, 200, freed ? { ok: true } : { ok: false, error: 'Nincs ilyen kitiltás.' });
        }
      }
    }
    return send(res, 404, { ok: false, error: 'Nincs ilyen cím.' });
  };

  /** Long poll on a room: answers at once if there is news, otherwise when news arrives or after POLL_WAIT_MS. */
  const roomPoll = (code: string, token: string, after: number, res: ServerResponse) => {
    const first = lobby.events(code, token, after);
    if (!first.ok || first.events.length) return send(res, 200, first);
    lobby.polling(code, token, true);
    let done = false;
    const finish = (answer: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      lobby.polling(code, token, false);
      if (answer) send(res, 200, lobby.events(code, token, after));
    };
    const unsubscribe = lobby.wait(code, () => finish(true));
    const timer = setTimeout(() => finish(true), POLL_WAIT_MS);
    res.on('close', () => finish(false));
  };

  /** Long poll on an account's own stream (friend requests, challenges, presence). */
  const accountPoll = (userId: string, after: number, res: ServerResponse) => {
    const user = accounts.byId(userId);
    if (!user) return send(res, 200, NO_AUTH);
    const first = accounts.events(user, after);
    if (first.events.length) return send(res, 200, { ok: true, ...first });
    accounts.polling(userId, true);
    let done = false;
    const finish = (answer: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      accounts.polling(userId, false);
      if (answer) send(res, 200, { ok: true, ...accounts.events(user, after) });
    };
    const unsubscribe = accounts.wait(userId, () => finish(true));
    const timer = setTimeout(() => finish(true), POLL_WAIT_MS);
    res.on('close', () => finish(false));
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: Error) => send(res, 400, { ok: false, error: e.message || 'Hiba.' }));
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  const ticker = setInterval(() => {
    lobby.tick();
    accounts.tick();
    requests.sweep();
    registrations.sweep();
  }, 3000);
  ticker.unref?.();

  return new Promise((resolve, reject) => {
    let tries = opts.portTries ?? 1;
    const attempt = () => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && --tries > 0) {
          port += 1;
          attempt();
        } else {
          clearInterval(ticker);
          reject(e);
        }
      });
      server.listen(port, opts.host ?? '0.0.0.0', () => {
        server.removeAllListeners('error');
        const addr = server.address();
        if (addr && typeof addr === 'object') port = addr.port;
        resolve({
          server,
          lobby,
          accounts,
          store,
          port,
          lanUrls: reachable(),
          close: () =>
            new Promise<void>((done) => {
              clearInterval(ticker);
              store.flush();
              server.closeAllConnections?.();
              server.close(() => done());
            }),
        });
      });
    };
    attempt();
  });
}
