# Mana Chess – backend

The server side of [Mana Chess](https://github.com/piguuccc-ops/mana-chess-frontend) (chess with a
Clash Royale-style mana and spell system). The game page is in the other repository; players type this
server's address into the game (**Online** in the main menu).

- **Accounts.** Register, sign in, stay signed in, change your password. Decks are stored on the server, so a
  deck follows its player to every device.
- **Friends.** Search by name, send, accept, decline and cancel friend requests, and see who is online or
  in a game. You can challenge a friend: if they accept, the game starts for both at once.
- **Rooms.** Open rooms and four-letter room codes, for signed-in players and for guests. Guest play is
  "LAN mode": no account, and decks stay in the browser. Games are authoritative: the server replays every
  move with the same rules engine as the page, so a modified page cannot cheat.
- **Two game modes** for rooms and challenges: your own decks, or **Spell-toborzás** (spell draft) – 32
  random, different spells on an 8 × 4 table, and the players take one each in turn until both have 6.
  The server deals the table and checks every pick.
- **Control panel** on a port of its own (**5555**), listening on the server itself only (`127.0.0.1`);
  from your PC you reach it through an SSH tunnel or Tailscale. The backend's port (5454), the one that
  goes on the internet, has no admin functions at all.
  - Registration can be closed, need admin approval, or be open (accepted automatically).
  - Create users by hand (they can sign in at once), approve, delete, reset passwords, make admins, and
    sign users out everywhere.
  - Switch guest play on or off, and see locked accounts, banned addresses and the log.
- **Built-in fail2ban.** 5 wrong passwords lock that account's login for 10 minutes; even the right
  password is refused until then. 10 failures from one address ban the address from signing in and
  registering for 10 minutes. Both limits are adjustable, and both locks can be lifted in the control panel.
- **Plain HTTP only.** Put it behind a reverse proxy such as Nginx Proxy Manager for HTTPS. Client
  addresses are taken from `X-Real-IP` / `X-Forwarded-For` only when the request comes from a local proxy.

## Install on a server – one file, one command

[`docker-compose.yml`](docker-compose.yml) runs the backend **and** the game page, each in its own
locked-down container. On a Linux server with Docker:

```bash
mkdir -p ~/mana-chess && cd ~/mana-chess
curl -fsSLO https://raw.githubusercontent.com/piguuccc-ops/mana-chess-backend/main/docker-compose.yml
docker compose up -d
```

Or make the file yourself (`nano docker-compose.yml`), paste this into it, and run `docker compose up -d`:

```yaml
# ─────────────────────────────────────────────────────────────────────────────
# Mana Chess: the game page, the backend (accounts, decks, friends, rooms) and its control panel,
# in two locked-down containers. This one file is the whole installation:
#
#   mkdir -p ~/mana-chess && cd ~/mana-chess
#   nano docker-compose.yml          paste this file, save: Ctrl+O, Enter, Ctrl+X
#   docker compose up -d             download and start
#   docker compose logs backend      the one-time setup code (BEÁLLÍTÓKÓD) for the admin account
#
#   Game:           http://SERVER-IP:4545      (port 4545)
#   Backend:        http://SERVER-IP:5454      (port 5454 – the game finds it by itself)
#   Control panel:  http://127.0.0.1:5555      (port 5555 – on the server only; from your PC through
#                                               an SSH tunnel or Tailscale, see DEPLOY.md)
#   (SERVER-IP is this server's address on your network – `hostname -I` shows it;
#    a server with a public IP, a VPS: see DEPLOY.md, step 5)
#
#   Update (accounts, decks and passwords stay):  docker compose pull && docker compose up -d
#   Guide:  https://github.com/piguuccc-ops/mana-chess-backend/blob/main/DEPLOY.md
# ─────────────────────────────────────────────────────────────────────────────
name: mana-chess

# the same lock-down for both containers
x-hardened: &hardened
  restart: unless-stopped
  init: true                      # a tiny init as PID 1: signals and stray processes handled properly
  user: "65532:65532"             # an unprivileged user (the images' own "nonroot"), never root
  read_only: true                 # the container's own files cannot be changed
  tmpfs:
    - /tmp:size=16m,mode=1777
  cap_drop:
    - ALL                         # no Linux capabilities at all
  security_opt:
    - no-new-privileges:true      # nothing inside can gain privileges later (setuid binaries etc.)
  pids_limit: 128
  logging:
    driver: json-file
    options:
      max-size: "10m"
      max-file: "3"

services:
  backend:
    <<: *hardened
    image: ghcr.io/piguuccc-ops/mana-chess-backend:latest
    container_name: mana-chess-backend
    environment:
      TZ: Europe/Budapest
      # The backend's address as players type it into the game (shown in the control panel).
      # Behind Nginx Proxy Manager: "https://sakk-api.example.com". Empty is fine at home.
      MANA_PUBLIC_URL: ""
    volumes:
      - data:/data                # accounts, decks, settings: the only place it can write to
    ports:
      - "5454:5454"               # the backend: players (and Nginx Proxy Manager) come here
      - "127.0.0.1:5555:5555"     # the control panel: this server only – never put it on the internet
    mem_limit: 256m
    cpus: 1.0
    # networks: [default, npm]    # NPM-NETWORK, see the end of this file

  frontend:
    <<: *hardened
    image: ghcr.io/piguuccc-ops/mana-chess-frontend:latest
    container_name: mana-chess-frontend
    environment:
      TZ: Europe/Budapest
      # The backend the game page offers by default. Empty: port 5454 on the host the page came
      # from (right for the home network). On the internet: "https://sakk-api.example.com"
      MANA_BACKEND: ""
    ports:
      - "4545:4545"               # the game page
    mem_limit: 128m
    cpus: 0.5
    # networks: [default, npm]    # NPM-NETWORK, see the end of this file

volumes:
  data:
    name: mana-chess-data         # survives updates and `docker compose down` (but not `down -v`!)

# NPM-NETWORK (optional): Nginx Proxy Manager runs in Docker on this same server, and you want it
# to reach the containers by name (mana-chess-backend:5454, mana-chess-frontend:4545)?
# Remove the "# " from the two "networks:" lines above and from the four lines below, and put
# NPM's network after "name:" (find it with: docker network ls). Then: docker compose up -d
# networks:
#   npm:
#     external: true
#     name: npm_default
```

Then:

1. Get the one-time setup code: `docker compose logs backend | grep BEÁLLÍTÓKÓD`
2. Open the control panel. It is on the server's `127.0.0.1:5555` only, so from your PC open an SSH
   tunnel and keep it open: `ssh -L 5555:127.0.0.1:5555 YOUR-USER@SERVER-IP`. Then open
   `http://localhost:5555`, enter the code, and create your admin account. (Tailscale works too: see
   [DEPLOY.md](DEPLOY.md), step 4.)
3. Play at `http://SERVER-IP:4545` → **Online**. The game finds the backend at `SERVER-IP:5454` by itself.

`SERVER-IP` is the server's address on your network (`hostname -I` shows it). Update with
`docker compose pull && docker compose up -d` – accounts, passwords and decks stay in the `mana-chess-data`
volume ([DEPLOY.md](DEPLOY.md), step 6).

**HTTPS with Nginx Proxy Manager, backups, the security checklist and troubleshooting: see
[DEPLOY.md](DEPLOY.md).**

## Without Compose

With `docker run`:

```bash
docker run -d --name mana-chess-backend --restart unless-stopped \
  -p 5454:5454 -p 127.0.0.1:5555:5555 -v mana-chess-data:/data \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  ghcr.io/piguuccc-ops/mana-chess-backend:latest
docker logs mana-chess-backend        # shows the one-time setup code (BEÁLLÍTÓKÓD)
```

Always publish the control panel's port as `127.0.0.1:5555:5555`, never as a bare `5555:5555`.

Without Docker (Node.js 18 or newer):

```bash
npm install
npm run build          # → dist/backend.mjs, one file, no node_modules needed to run it
npm start              # backend http://localhost:5454, control panel http://localhost:5555, data in ./data
```

On the first start the server prints a **setup code** and opens the control panel (`http://localhost:5555`),
where the code creates the first admin account. Outside Docker the control panel listens on `127.0.0.1`
only. For a lost admin password, start the server with `--setup` (Docker: `MANA_SETUP=1`) to get a new
code.

## Configuration

| Command line | Environment | Default | Meaning |
|---|---|---|---|
| `--port 9000` | `PORT` | `5454` | The backend's port (the one players and the proxy use) |
| `--host 127.0.0.1` | `HOST` | all interfaces | The backend's address to listen on |
| `--admin-port 9001` | `ADMIN_PORT` | `5555` | The control panel's port |
| `--admin-host 0.0.0.0` | `ADMIN_HOST` | `127.0.0.1` (`0.0.0.0` inside a container – publish it as `127.0.0.1:5555:5555`) | The control panel's address to listen on |
| `--data <folder>` | `MANA_DATA` | `./data` next to `backend.mjs` (`/data` in Docker) | Where `mana-chess.json` is kept |
| | `MANA_PUBLIC_URL` | this machine's LAN addresses | The address players type in (shown in the control panel and the log), e.g. `https://sakk-api.example.com` |
| `--setup` | `MANA_SETUP=1` | | Print a new one-time setup code (admin password reset) |
| `--no-open` | | | Don't open the control panel in a browser on the first start |

Without `--port` / `--admin-port` (and without `PORT` / `ADMIN_PORT`) a busy port is skipped: the server
takes the next free one and prints it.

Everything else is set in the control panel and saved in the data file:
- server name;
- registration mode;
- guest play;
- fail2ban limits;
- proxy trust.

## Security notes

- **Passwords** are hashed with salted scrypt (N=16384, r=8, p=1).
- **Session tokens** are 32 random bytes; only their SHA-256 is stored. A session expires after 30 days
  without use, and each account keeps at most 10.
- **Comparisons** are constant-time. An unknown name costs as much work as a known one, so names can't be
  probed by timing.
- **Rate limits:** 1200 requests per minute per address, and 5 new accounts per hour per address.
- **Request bodies** are limited to 64 KB, and every field is cleaned and validated.
- **The control panel** is a separate listener on its own port, bound to `127.0.0.1` (published only on the
  server's `127.0.0.1` in Docker). It accepts only admin accounts, sends no CORS headers, has a strict
  Content-Security-Policy with a per-request nonce, and cannot be framed. On the public port every
  `/api/admin/…` path is simply not found.
- **The data file** is written atomically (temporary file + rename) with mode `0600`.
- **The Docker image** is distroless: no shell and no package manager. It runs as uid 65532 and works with
  a read-only filesystem and all capabilities dropped (see [`docker-compose.yml`](docker-compose.yml)).

To report a security problem, see [SECURITY.md](SECURITY.md).

## Development

```bash
npm install
npm run dev            # tsx server/main.ts – data in ./data
npm test               # Vitest: accounts, fail2ban, friends, challenges, rooms, HTTP
npm run typecheck
npm run build          # dist/backend.mjs + dist/healthcheck.mjs
```

### The shared rules

The backend and the game must run exactly the same rules. Each carries a version: a hash of
`src/engine/**` and `src/net/protocol.ts`. A page with a different version is turned away with a clear
message. The game repository is the source of that code. After changing the rules there, bring them here
and commit both repositories:

```bash
npm run sync -- ../mana-chess-frontend
```

This copies `src/engine/`, `src/net/protocol.ts`, `src/net/client.ts` and `tests/helpers.ts` from the game
repository. In the other direction, it gives the game repository this server's `lobby.ts` as a test
fixture. It then checks that both versions match.

## Layout

```
docker-compose.yml   the whole server installation: backend + game page (see DEPLOY.md)
server/
  main.ts            command line, environment, startup banner
  index.ts           the two HTTP listeners: the public API (JSON over long polling, CORS) and the
                     control panel; rate limits
  accounts.ts        accounts, sessions, fail2ban, decks, friends, presence, challenges, admin operations
  lobby.ts           rooms and authoritative games (every action checked with the engine)
  store.ts           the JSON data file (atomic, debounced writes)
  security.ts        scrypt, tokens, address bans, client address behind a proxy
  adminApp.ts        the control panel (sent to the browser as plain JavaScript)
  pages.ts           the control panel page and the public port's landing page
src/                 shared with the game – copied by `npm run sync` (engine, protocol, client)
tests/               Vitest
docker/              the image's health check
release/             Start.bat / start.sh / README.txt for running without Docker
.github/             CI, image build (GHCR + optional Docker Hub), releases, Dependabot
```

## Images and releases

GitHub Actions builds the image for `linux/amd64` and `linux/arm64` and publishes it as
`ghcr.io/piguuccc-ops/mana-chess-backend`.
- **Tags:** `latest` on `main`, `1.2.3` / `1.2` for tags `v1.2.3`, and `sha-<commit>`.
- **Docker Hub:** also published there when the repository has the secrets `DOCKERHUB_USERNAME` and
  `DOCKERHUB_TOKEN`.
- **Weekly rebuild:** the image is rebuilt every week, so the base image's security fixes arrive without
  a new commit.
- **Release zip:** a `v*` tag also creates a GitHub release with a zip for running without Docker.

## License

[MIT](LICENSE) © 2026 piguuccc-ops. The software is provided "as is", without warranty of any kind, and the
author is not liable for any claim, damage or other liability arising from it or its use. The full text is in
[LICENSE](LICENSE).
