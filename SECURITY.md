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
- **Control panel.** A strict CSP with a nonce, framing is denied, and it is admin-only. The first admin
  needs a one-time code printed in the server's log.
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
- Expose only your reverse proxy (80/443) to the internet.
- Keep registration on **approval** and turn guest play off on a public server.
- Restrict `/admin` in the proxy (an access list) if you can.
- Update with `docker compose pull && docker compose up -d`.
