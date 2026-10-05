# Security

## Reporting a problem

Please don't open a public issue for a security problem. Use GitHub's **Report a vulnerability** button:
Security tab → Advisories. Only the maintainers can see those reports. You can also contact the
maintainer privately.

## What is in place

- **Accounts.**
  - Passwords are hashed with salted scrypt.
  - Session tokens are random and stored only as a hash.
  - Comparisons are constant-time.
  - Unknown names take as long as known ones.
- **Brute force.**
  - 5 wrong passwords lock that account for 10 minutes.
  - 10 failures from one address ban it for 10 minutes.
  - Both limits are adjustable in the control panel.
  - Per-address rate limits cover requests and registrations.
- **Input.**
  - Bodies are limited to 64 KB.
  - Every field is cleaned.
  - Every game action is checked by the server's own rules engine.
- **Ranked play.**
  - Matchmaking, ratings and the leaderboard need a signed-in session; ratings change only on the server,
    from the result of a game it refereed itself.
  - A ranked game cannot be stalled: 3 minutes per turn, a minute away, and leaving all count as a loss.
- **Control panel.**
  - A separate listener on its own port (5555), bound to `127.0.0.1`; `docker-compose.yml` publishes it on
    the server's `127.0.0.1` only. The public port (5454) has no admin page and no admin API.
  - Admin accounts only; a strict CSP with a nonce, no CORS, and framing is denied.
  - The first admin needs a one-time code printed in the server's log.
- **Container.**
  - A distroless image with no shell and no package manager.
  - Runs as a non-root user (uid 65532).
  - Works with a read-only root filesystem, all Linux capabilities dropped and `no-new-privileges`.
  - Data lives only in `/data`, and the data file is `0600`.
- **Supply chain.**
  - Dependabot watches npm packages, the base images and GitHub Actions.
  - Images are rebuilt weekly and published with SBOM and provenance attestations.

## Recommended setup

See [DEPLOY.md](DEPLOY.md). In short:
- Expose only your reverse proxy (80/443) to the internet, and proxy only the backend's port (5454) and the
  game page's port (4545).
- Never publish the control panel's port (5555) beyond `127.0.0.1`. Reach it through an SSH tunnel or
  Tailscale (`tailscale serve`, never `tailscale funnel`).
- Keep registration on **approval** and turn guest play off on a public server.
- Update with `docker compose pull && docker compose up -d`.
