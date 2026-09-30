# Installing Mana Chess on a server

Installing takes one file and one command. [`docker-compose.yml`](docker-compose.yml) starts two
separate, locked-down containers, and Docker downloads the images from GitHub:

```
~/mana-chess/docker-compose.yml   starts:

  mana-chess-frontend   port 8080   the game page
  mana-chess-backend    port 8787   accounts, decks, friends, rooms, the /admin control panel
     └─ Docker volume "mana-chess-data": mana-chess.json – every account, deck and setting

At home:          http://SERVER-IP:8080  (the page finds the backend at SERVER-IP:8787 by itself)
On the internet:  https://sakk.example.com      → Nginx Proxy Manager → port 8080
                  https://sakk-api.example.com  → Nginx Proxy Manager → port 8787
```

`SERVER-IP` is the server's address on your home network, e.g. `192.168.1.10` (`hostname -I` shows it).
`sakk.example.com` and `sakk-api.example.com` stand for your own domain names.

**Step 1 is done once, by you, on GitHub.** After that, installing on any server is only steps 2–4.

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

## 4. Create your admin account

The first start prints a one-time **setup code** in the backend's log:

```bash
docker compose logs backend | grep BEÁLLÍTÓKÓD
```

The line looks like `BEÁLLÍTÓKÓD:  7KQ2-M4XP`. If you see several lines, the last one is valid (each start
before setup makes a new code).

1. Open `http://SERVER-IP:8787/admin` in your browser.
2. Enter the code, then choose your admin name and password.

The code works once. It proves you are the one running the server.

The control panel has several tabs:
- **Beállítások** (Settings):
  - server name;
  - registration: *closed*, *with approval* (the default) or *open* (accepted automatically);
  - guest play on or off;
  - the fail2ban limits (by default, 5 wrong passwords lock that account for 10 minutes).
- **Felhasználók** (Users): create users by hand (they can sign in straight away), approve registrations,
  reset passwords, delete users.
- **Biztonság** (Security): locked accounts and banned addresses, each with an unlock button.

**Play on the home network:** open `http://SERVER-IP:8080` and go to **Online**. The game finds the
backend at `SERVER-IP:8787` by itself. Choose **Belépés** (sign in), **Regisztráció** (register) or
**Vendégként** (play as a guest: no account, decks stay in the browser). Phones on the same Wi-Fi use the
same address.

---

## 5. On the internet with HTTPS (Nginx Proxy Manager)

The backend and the game page speak only plain HTTP; Nginx Proxy Manager (NPM) puts HTTPS in front of
them. Players then reach everything on port 443, even on networks that only let https through.

**First, on the router and in DNS:**
- Point two DNS names at your public IP address: `sakk.example.com` for the game and
  `sakk-api.example.com` for the backend.
- Forward only ports **80 and 443**, to NPM. Never forward 8787 or 8080.

**In NPM**, go to **Hosts → Proxy Hosts → Add Proxy Host** and add two hosts:

| | Backend | Game page |
|---|---|---|
| Domain Names | `sakk-api.example.com` | `sakk.example.com` |
| Scheme | `http` | `http` |
| Forward Hostname / IP | `SERVER-IP` | `SERVER-IP` |
| Forward Port | `8787` | `8080` |
| Block Common Exploits | on | on |
| SSL tab | Request a new SSL Certificate, **Force SSL**, HTTP/2, HSTS | the same |

Use the server's network address (`SERVER-IP`) even when NPM runs in Docker on the same server. Don't
use `localhost` or `127.0.0.1`: inside NPM's container those mean NPM itself. Websockets support isn't
needed, because the game uses ordinary HTTP requests.

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

### Optional: keep the control panel off the internet

You can make the control panel reachable only from home. In the backend's proxy host, open the
**Advanced** tab and add:

```nginx
location = /admin { return 403; }
location ^~ /api/admin/ { return 403; }
```

Players are unaffected. You then manage the server at `http://SERVER-IP:8787/admin` from home.

### Optional: a server with a public IP (VPS), or no open ports at all

Docker's published ports get past UFW. On a server that is directly on the internet, don't publish
8787 and 8080 to the world:

1. In `docker-compose.yml`, change the two port lines to `"127.0.0.1:8787:8787"` and
   `"127.0.0.1:8080:8080"`.
2. If NPM runs in Docker on the same server, it can't reach `127.0.0.1` of the server. Put the containers
   on NPM's network instead. Find its name with `docker network ls` (usually `npm_default` or
   `nginx-proxy-manager_default`). Then follow the **NPM-NETWORK** note at the end of `docker-compose.yml`:
   remove the `# ` from the marked lines and put the network name after `name:`.
3. Run `docker compose up -d`.
4. In the two proxy hosts, set **Forward Hostname** to `mana-chess-backend` (port `8787`) and
   `mana-chess-frontend` (port `8080`).

To reach the control panel then, use an SSH tunnel from your PC: `ssh -L 8787:127.0.0.1:8787 USER@SERVER`,
then open `http://localhost:8787/admin`.

---

## 6. Everyday tasks

Run these in `~/mana-chess`:

| Task | Command |
|---|---|
| Update to the newest version | `docker compose pull && docker compose up -d && docker image prune -f` |
| State and health | `docker compose ps` |
| Watch the backend's log | `docker compose logs -f backend` (Ctrl+C to stop watching) |
| Restart / stop / start | `docker compose restart` · `docker compose stop` · `docker compose up -d` |
| Change a setting | `nano docker-compose.yml`, then `docker compose up -d` |
| Remove the containers (data stays) | `docker compose down` |

**Never run `docker compose down -v`.** The `-v` deletes the data volume, which holds every account.

**Pinning a version.** Change `:latest` to a version, e.g. `:1.0.0`, in both `image:` lines, and update on
purpose. Always run the backend and the game page from the **same release**: the backend turns away pages
built with different rules, and shows a clear message saying so.

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
Running games are kept only in memory, so a restart ends them. Accounts and decks stay.

**Lost admin password.** Start the backend once with `--setup` and use the new code:

```bash
docker compose stop backend
docker compose run --rm --service-ports backend --setup
```

1. The output shows a new `BEÁLLÍTÓKÓD`.
2. Open `http://SERVER-IP:8787/admin`, then enter the code, your admin **name** and a new password.
3. Press Ctrl+C, then run `docker compose up -d`.

**Where the data is on disk:** `docker volume inspect mana-chess-data` shows the folder (normally
`/var/lib/docker/volumes/mana-chess-data/_data`, readable only with `sudo`).

---

## 7. Security checklist

What the setup already does:

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
  - Passwords are hashed with scrypt; session tokens are stored only as hashes.
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
- [ ] Optionally keep `/admin` off the internet (step 5).
- [ ] Update regularly: `docker compose pull && docker compose up -d`.
- [ ] Back up the data file (step 6).

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `docker compose up -d` says *denied* or *unauthorized* | The image is still private: step 1.3. |
| … says *manifest unknown* or *not found* | The image doesn't exist yet: check the **Actions** tab of both repositories (step 1.2). |
| … says *no matching manifest for linux/arm/v7* | 32-bit ARM isn't supported. Use a 64-bit OS (amd64 or arm64). |
| `curl` says *404* | The backend repository is private or has another name. Paste the file by hand instead (step 3). |
| `port is already allocated` | Something else uses 8787 or 8080. Change the **left** number of the port line, e.g. `"9787:8787"`, then use that port in the addresses. |
| The backend keeps restarting; its log says `Az adatfájl megvan, de nem olvasható` | A restored file without `-a`. Do the restore again, with `docker compose cp -a` (step 6). |
| The backend keeps restarting; its log says `Az adatmappa nem írható` | Only happens if you replaced the volume with a folder (`./data:/data`): `sudo chown -R 65532:65532 ./data` |
| NPM shows *502 Bad Gateway* | The Forward Hostname must be `SERVER-IP`, not `localhost`. With the NPM-NETWORK setup: the network name must be right, and `docker inspect mana-chess-backend --format '{{json .NetworkSettings.Networks}}'` must list it. |
| `network npm_default declared as external, but could not be found` | Wrong network name after `name:`; check `docker network ls`. |
| The game says it can't reach the server | Open the address in a browser: `https://sakk-api.example.com/api/info` must show a short JSON. On an https page only an https backend works. |
| The game says the versions don't match | The backend and the game page come from different releases. Update both: `docker compose pull && docker compose up -d`. |
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
