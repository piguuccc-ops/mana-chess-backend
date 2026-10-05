# Installing Mana Chess on a server

Installing takes one file and one command. [`docker-compose.yml`](docker-compose.yml) starts two
separate, locked-down containers, and Docker downloads the images from GitHub:

```
~/mana-chess/docker-compose.yml   starts:

  mana-chess-frontend   port 4545   the game page
  mana-chess-backend    port 5454   accounts, decks, friends, rooms – what players use
                        port 5555   the control panel – on the server only (127.0.0.1)
     └─ Docker volume "mana-chess-data": mana-chess.json – every account, password, deck and setting

At home:          http://SERVER-IP:4545  (the page finds the backend at SERVER-IP:5454 by itself)
On the internet:  https://sakk.example.com      → Nginx Proxy Manager → port 4545
                  https://sakk-api.example.com  → Nginx Proxy Manager → port 5454
Control panel:    http://127.0.0.1:5555 on the server – from your PC through SSH or Tailscale (step 4)
```

`SERVER-IP` is the server's address on your home network, e.g. `192.168.1.10` (`hostname -I` shows it).
`sakk.example.com` and `sakk-api.example.com` stand for your own domain names.

**Step 1 is done once, by you, on GitHub.** After that, installing on any server is only steps 2–4.
Updating later: step 6.

---

## 1. Once: put the code on GitHub – it builds the images

The images `ghcr.io/piguuccc-ops/mana-chess-backend` and `ghcr.io/piguuccc-ops/mana-chess-frontend`
are built by GitHub Actions in your two repositories. Until they exist, `docker compose up -d` has
nothing to download.

### 1.1 Create the two repositories and push the code

You have two folders: `mana-chess-backend` and `mana-chess-frontend`. Make each one a **public**
repository with exactly that name. Pick one of these ways:

- **GitHub Desktop** (easiest on Windows):
  1. **File → Add local repository**, choose the `mana-chess-backend` folder.
  2. It says the folder is not a Git repository yet: click **create a repository**, then
     **Create repository**.
  3. Click **Publish repository**, untick **Keep this code private**, then **Publish repository**.
  4. Do the same with `mana-chess-frontend`.
- **Command line** (Git): first create two empty repositories on github.com (**New repository**, the name,
  **Public**, no README). Then in each folder:

  ```bash
  cd mana-chess-backend
  git init -b main
  git add .
  git commit -m "Mana Chess backend"
  git remote add origin https://github.com/piguuccc-ops/mana-chess-backend.git
  git push -u origin main
  ```

  Do the same in `mana-chess-frontend`, with its own name. On Windows, the first push opens a browser
  window to sign in to GitHub.

Nothing secret is in the code. Accounts and passwords live only on your server.

### 1.2 Wait for the images

Every push starts the **Docker image** workflow (the repository's **Actions** tab). It runs the tests,
then builds the image for normal PCs (amd64) and ARM boards such as a Raspberry Pi 4/5 (arm64). Wait
until it has a green tick in **both** repositories. It takes a few minutes.

### 1.3 Make the two images public

GitHub starts new images as **private**, and then a server can't download them without a password.
For **each** of the two images:

1. Open your packages: `https://github.com/piguuccc-ops?tab=packages`
2. Click **mana-chess-backend**, then **Package settings** (bottom right).
3. Under **Danger Zone**, click **Change visibility** → **Public**, and type the name to confirm.

Repeat this for **mana-chess-frontend**. A public image can't be made private again. That's fine: the
images hold only the program, never your data.

From now on it all runs by itself:
- **Every push to `main`** updates the `latest` images.
- **Every Monday** the images are rebuilt, so security fixes of the base image arrive without you doing
  anything.
- **A version tag** gives fixed versions: `git tag v1.0.0 && git push --tags` makes `:1.0.0` and `:1.0`,
  and a GitHub release with zips for running without Docker.

---

## 2. Install Docker on the server

Skip this step if `docker compose version` already prints a version. Otherwise, on Ubuntu, install
Docker's own packages:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker compose version
```

About the `docker` group: `sudo usermod -aG docker $USER` (then log out and back in) lets you run `docker`
without `sudo`. But anyone in that group is effectively root on the server. If you'd rather not, put
`sudo` in front of the `docker …` commands below.

---

## 3. Install Mana Chess

```bash
mkdir -p ~/mana-chess && cd ~/mana-chess
curl -fsSLO https://raw.githubusercontent.com/piguuccc-ops/mana-chess-backend/main/docker-compose.yml
docker compose up -d
```

Or paste the file by hand:

1. On GitHub, open [`docker-compose.yml`](docker-compose.yml) and click **Copy raw file** (the copy icon
   above the file).
2. On the server, run `mkdir -p ~/mana-chess && cd ~/mana-chess && nano docker-compose.yml`.
3. Paste (right-click, or Ctrl+Shift+V), then save with Ctrl+O, Enter, Ctrl+X.
4. Run `docker compose up -d`.

Docker downloads both images and starts them. After about 30 seconds, `docker compose ps` shows both
containers as **healthy**.

---

## 4. The control panel and your admin account

The control panel has a port of its own, **5555**, and it listens only on the server itself
(`127.0.0.1`). Nothing of it exists on the backend's port 5454 – the one that goes on the internet – so
nobody can even try an admin password from outside.

**Open it from your PC** – pick one:

- **SSH tunnel** (works everywhere). On your PC, in Terminal or PowerShell, keep this window open:

  ```bash
  ssh -L 5555:127.0.0.1:5555 YOUR-USER@SERVER-IP
  ```

  Then open `http://localhost:5555` in your PC's browser.
- **Tailscale** (if the server is in your tailnet). Once, on the server:

  ```bash
  sudo tailscale serve --bg --https=5555 http://127.0.0.1:5555
  ```

  From then on, any of your own Tailscale devices opens `https://SERVER-NAME.YOUR-TAILNET.ts.net:5555`
  (`tailscale serve status` prints the exact address). Only devices in your tailnet reach it. If it asks
  you to enable HTTPS certificates, open the link it prints. To switch it off again:
  `sudo tailscale serve --https=5555 off`. Never use `tailscale funnel` for it: that would put it on the
  internet.
- **On the server itself**, if it has a desktop: `http://127.0.0.1:5555`.

**Create your admin account.** The first start prints a one-time **setup code** in the backend's log:

```bash
docker compose logs backend | grep BEÁLLÍTÓKÓD
```

The line looks like `BEÁLLÍTÓKÓD:  7KQ2-M4XP`. If you see several lines, the last one is valid (each start
before setup makes a new code). In the control panel, enter the code, then choose your admin name and
password. The code works once.

The control panel accepts only admin accounts. Its tabs:
- **Beállítások** (Settings):
  - server name;
  - registration: *closed*, *with approval* (the default) or *open* (accepted automatically);
  - guest play on or off;
  - the fail2ban limits (by default, 5 wrong passwords lock that account for 10 minutes).
- **Felhasználók** (Users): create users by hand (they can sign in straight away), approve registrations,
  reset passwords, delete users.
- **Biztonság** (Security): locked accounts and banned addresses, each with an unlock button.

**Play on the home network:** open `http://SERVER-IP:4545` and go to **Online**. The game finds the
backend at `SERVER-IP:5454` by itself. Choose **Belépés** (sign in), **Regisztráció** (register) or
**Vendégként** (play as a guest: no account, decks stay in the browser). Phones on the same Wi-Fi use the
same address.

**Game modes.** In the game, **Csatába! → Paklik** (and online in a room or a challenge) you choose
between your own decks and **Spell-toborzás**: 32 random spells on an 8 × 4 table, the two players take
one each in turn until both have 6.

---

## 5. On the internet with HTTPS (Nginx Proxy Manager)

The backend and the game page speak only plain HTTP; Nginx Proxy Manager (NPM) puts HTTPS in front of
them. Players then reach everything on port 443, even on networks that only let https through.

**First, on the router and in DNS:**
- Point two DNS names at your public IP address: `sakk.example.com` for the game and
  `sakk-api.example.com` for the backend.
- Forward only ports **80 and 443**, to NPM. Never forward 4545, 5454 or 5555.

**In NPM**, go to **Hosts → Proxy Hosts → Add Proxy Host** and add two hosts:

| | Game page | Backend |
|---|---|---|
| Domain Names | `sakk.example.com` | `sakk-api.example.com` |
| Scheme | `http` | `http` |
| Forward Hostname / IP | `SERVER-IP` | `SERVER-IP` |
| Forward Port | `4545` | `5454` |
| Block Common Exploits | on | on |
| SSL tab | Request a new SSL Certificate, **Force SSL**, HTTP/2, HSTS | the same |

Use the server's network address (`SERVER-IP`) even when NPM runs in Docker on the same server. Don't
use `localhost` or `127.0.0.1`: inside NPM's container those mean NPM itself. Websockets support isn't
needed, because the game uses ordinary HTTP requests. **Never make a proxy host for port 5555.**

**Then tell the game page where the backend is.** In `~/mana-chess/docker-compose.yml`, fill in the two
empty addresses:

```yaml
      MANA_PUBLIC_URL: "https://sakk-api.example.com"      # under backend
      MANA_BACKEND: "https://sakk-api.example.com"         # under frontend
```

Apply the change with `docker compose up -d`. This recreates the containers, and the data stays. Now
`https://sakk.example.com` → **Online** connects by itself.

**Why the backend needs https too:** a page opened over https may not talk to an http address, because
the browser blocks it. So on the internet, always use the backend's `https://` address.

### Optional: a server with a public IP (VPS), or no open ports at all

Docker's published ports get past UFW. On a server that is directly on the internet, don't publish
4545 and 5454 to the world (5555 is already on `127.0.0.1` only):

1. In `docker-compose.yml`, change the two port lines to `"127.0.0.1:5454:5454"` and
   `"127.0.0.1:4545:4545"`.
2. If NPM runs in Docker on the same server, it can't reach `127.0.0.1` of the server. Put the containers
   on NPM's network instead. Find its name with `docker network ls` (usually `npm_default` or
   `nginx-proxy-manager_default`). Then follow the **NPM-NETWORK** note at the end of `docker-compose.yml`:
   remove the `# ` from the marked lines and put the network name after `name:`.
3. Run `docker compose up -d`.
4. In the two proxy hosts, set **Forward Hostname** to `mana-chess-frontend` (port `4545`) and
   `mana-chess-backend` (port `5454`).

---

## 6. Updating – accounts, decks and passwords stay

Everything that matters lives in the Docker volume `mana-chess-data`: every account, every password (as a
scrypt hash), the decks saved on the server, friends and settings. Updating replaces only the programs;
the volume is never touched. Two more things to know:
- Decks made **as a guest** live in each player's browser, tied to the game page's address. Keep the
  same address (`http://SERVER-IP:4545`, or your domain) and they stay too.
- Games in progress end when the backend restarts. Update when nobody is playing.

**The update, when you have pushed new code to GitHub (or the weekly rebuild ran):**

1. Wait for the green ticks of the **Docker image** workflow in **both** repositories.
2. On the server, make a backup first (it takes a second):

   ```bash
   cd ~/mana-chess
   mkdir -p ~/mana-chess-backups
   docker compose cp backend:/data/mana-chess.json ~/mana-chess-backups/before-update-$(date +%F).json
   ```

3. If the new version comes with a new `docker-compose.yml` (its release notes say so), fetch it. Your old
   one is kept as `docker-compose.old.yml`; copy your own changes (the two addresses of step 5, ports)
   into the new file:

   ```bash
   cp docker-compose.yml docker-compose.old.yml
   curl -fsSLO https://raw.githubusercontent.com/piguuccc-ops/mana-chess-backend/main/docker-compose.yml
   ```

   **Coming from the first version** (ports 8787 and 8080 inside the containers, control panel at
   `/admin`)? Then this step is a must: the ports inside the containers changed to 5454 and 4545, and the
   control panel moved to its own port, 5555. With the old file the game could not reach the backend.
   The volume name is the same (`mana-chess-data`), so all accounts and decks are still there.

4. Download and start the new version:

   ```bash
   docker compose pull && docker compose up -d && docker image prune -f
   ```

5. Check: `docker compose ps` shows both **healthy**, and you can sign in.

Always update the backend and the game page **together** (the command above does): the backend turns
away a game page built with different rules, and says so. **Never run `docker compose down -v`**: the
`-v` deletes the data volume, which holds every account.

**The version with bots, ranked play and the Android app** needs nothing special: the same
`docker-compose.yml`, the same volume. On its first start every existing account gets an Élő-pontszám of
1000 (and an empty ranked record); nothing else in the data changes. Players of the **Android app** need the
APK of the same release (the app shows an „Az alkalmazás frissítése” button when it no longer matches the
server).

To go back to an older version, put its tag (e.g. `:1.0.0`) in both `image:` lines and run
`docker compose up -d`. If the data itself must go back, restore the backup (step 7).

---

## 7. Everyday tasks

Run these in `~/mana-chess`:

| Task | Command |
|---|---|
| State and health | `docker compose ps` |
| Watch the backend's log | `docker compose logs -f backend` (Ctrl+C to stop watching) |
| Restart / stop / start | `docker compose restart` · `docker compose stop` · `docker compose up -d` |
| Change a setting | `nano docker-compose.yml`, then `docker compose up -d` |
| Remove the containers (data stays) | `docker compose down` |

**Backup.** All accounts, decks, friends and settings are in one file. The server writes it atomically,
so you can copy it at any time:

```bash
mkdir -p ~/mana-chess-backups
docker compose cp backend:/data/mana-chess.json ~/mana-chess-backups/mana-chess-$(date +%F).json
```

For a nightly copy, run `crontab -e` and add this line (change `USER`; without the `docker` group, use
`sudo crontab -e`):

```
15 4 * * * docker cp mana-chess-backend:/data/mana-chess.json /home/USER/mana-chess-backups/mana-chess-$(date +\%F).json
```

**Restore** a copy. Stop the backend first, or it would save over the restored file:

```bash
docker compose stop backend
docker compose cp -a ~/mana-chess-backups/mana-chess-2026-01-31.json backend:/data/mana-chess.json
docker compose up -d
```

The `-a` matters: it gives the file to the container's user. Without it the backend can't read the file.
It then refuses to start rather than start empty, and its log shows the command to run again with `-a`.

**Lost admin password.** Start the backend once with `--setup` and use the new code:

```bash
docker compose stop backend
docker compose run --rm --service-ports backend --setup
```

1. The output shows a new `BEÁLLÍTÓKÓD`.
2. Open the control panel (step 4), then enter the code, your admin **name** and a new password.
3. Press Ctrl+C, then run `docker compose up -d`.

**Where the data is on disk:** `docker volume inspect mana-chess-data` shows the folder (normally
`/var/lib/docker/volumes/mana-chess-data/_data`, readable only with `sudo`).

**Ratings.** The control panel's user list shows every player's Élő-pontszám and ranked games; *Élő
visszaállítása* puts one back to 1000 (e.g. after abuse). The *rangsorolt keresés* number on its front page
shows how many players are looking for an opponent right now.

**The Android app for your players.** In the game repository (**mana-chess-frontend**) on GitHub, once:
add the signing key as secrets and your server's address as the variable `MANA_BACKEND` (Settings →
Secrets and variables → Actions – the exact names are in `android/README.md`). From then on every version
tag (`v1.2.0`) puts `mana-chess-v1.2.0.apk` on the release page, already pointing at your server. Players
download it on the phone, allow installing from this source once, and install; an update is installed over
the old one and keeps their decks and settings.

---

## 8. Security checklist

What the setup already does:

- **The control panel is apart.** It has its own port (5555), published on the server's `127.0.0.1`
  only, and it accepts only admin accounts. The backend's port, the one on the internet, has no admin
  functions at all.
- **No root.** Both containers run as user 65532.
- **Distroless images.** No shell and no package manager inside, which leaves an attacker little to work
  with.
- **Locked-down containers.**
  - Read-only filesystem: the program can't be changed. Only the data volume is writable, and only by the
    backend.
  - **No Linux capabilities**, and **no-new-privileges**.
  - Limits on memory, CPU and the number of processes.
  - Log rotation (3 × 10 MB).
- **Accounts.**
  - Passwords are hashed with scrypt; nobody can read them back, not even an admin. Session tokens are
    stored only as hashes.
  - The data file is readable by its owner only.
- **Built-in fail2ban.** 5 wrong passwords lock the account for 10 minutes. 10 failures from one address
  ban it for 10 minutes. The limits can be changed in the control panel.
- **Strict CSP.** The game page only runs its own code.
- **Updates.** The images are rebuilt weekly, and Dependabot proposes updates to the code.

What you should do:

- [ ] Forward only 80/443 on the router, to NPM. On a server with a public IP, follow the VPS part of
      step 5.
- [ ] Use a long admin password. Keep registration on **with approval**, and turn **guest play off** if the
      server is on the internet (Beállítások tab).
- [ ] Never publish port 5555 anywhere else, and never make an NPM proxy host or a Tailscale funnel for it.
- [ ] Update regularly (step 6), and back up the data file (step 7).

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `docker compose up -d` says *denied* or *unauthorized* | The image is still private: step 1.3. |
| … says *manifest unknown* or *not found* | The image doesn't exist yet: check the **Actions** tab of both repositories (step 1.2). |
| … says *no matching manifest for linux/arm/v7* | 32-bit ARM isn't supported. Use a 64-bit OS (amd64 or arm64). |
| `curl` says *404* | The backend repository is private or has another name. Paste the file by hand instead (step 3). |
| `port is already allocated` | Something else uses 4545 or 5454. Change the **left** number of the port line, e.g. `"4546:4545"`, then use that port in the addresses. |
| The SSH tunnel says *address already in use* | Port 5555 is taken on your PC: use `ssh -L 15555:127.0.0.1:5555 …` and open `http://localhost:15555`. |
| The control panel doesn't open | It isn't on the backend's port any more: use port 5555 through SSH or Tailscale (step 4). Check that `docker-compose.yml` has the line `"127.0.0.1:5555:5555"`. |
| After updating from the first version, `http://SERVER-IP:4545` doesn't open and the backend doesn't answer | The old `docker-compose.yml` still points to ports 8080 and 8787 inside the containers. Fetch the new file (step 6, point 3), then `docker compose up -d`. Nothing is lost. |
| The backend keeps restarting; its log says `Az adatfájl megvan, de nem olvasható` | A restored file without `-a`. Do the restore again, with `docker compose cp -a` (step 7). |
| The backend keeps restarting; its log says `Az adatmappa nem írható` | Only happens if you replaced the volume with a folder (`./data:/data`): `sudo chown -R 65532:65532 ./data` |
| NPM shows *502 Bad Gateway* | The Forward Hostname must be `SERVER-IP`, not `localhost`. With the NPM-NETWORK setup: the network name must be right, and `docker inspect mana-chess-backend --format '{{json .NetworkSettings.Networks}}'` must list it. |
| `network npm_default declared as external, but could not be found` | Wrong network name after `name:`; check `docker network ls`. |
| The game says it can't reach the server | Open the address in a browser: `https://sakk-api.example.com/api/info` must show a short JSON. On an https page only an https backend works. |
| The game says the versions don't match | The backend and the game page come from different releases. Update both (step 6). |
| The Actions run is red | Open it and read the failed step's log. The image is only built when the tests pass. |

**Uninstall:** `docker compose down --rmi all`, then `docker volume rm mana-chess-data` (this deletes
every account), then delete `~/mana-chess`.

---

## Appendix: other ways to get the images

**Docker Hub as well.**
1. On hub.docker.com, go to Account settings → **Personal access tokens** and create a token with read &
   write access.
2. In **both** GitHub repositories, go to Settings → Secrets and variables → **Actions** and add
   `DOCKERHUB_USERNAME` (your Docker Hub user name) and `DOCKERHUB_TOKEN` (the token).
3. From the next push on, the images are also published as `<your Docker Hub name>/mana-chess-backend` and
   `…/mana-chess-frontend`. To use them, change the two `image:` lines.

**Private repositories and images.** If you keep them private, the `curl` link doesn't work: paste the file
by hand. To download private images, create a GitHub token with only the **read:packages** scope
(Settings → Developer settings → Personal access tokens → Tokens (classic)), then on the server run
`docker login ghcr.io -u piguuccc-ops` and paste the token as the password.

**Build on the server, no registry.** Clone both repositories, then run
`docker build -t mana-chess-backend:local .` and `docker build -t mana-chess-frontend:local .` in them. In
`docker-compose.yml`, set the two `image:` lines to `mana-chess-backend:local` and
`mana-chess-frontend:local`.
