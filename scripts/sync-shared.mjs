// ─────────────────────────────────────────────────────────────────────────────
// The rules are shared: the backend replays every game with the same engine as the page, and the
// two only talk to each other when their versions (a hash of the rules) match. The game repository
// (mana-chess-frontend) is the source of the shared code; this script brings it over:
//
//   game repo → here:   src/engine/**, src/net/protocol.ts, src/net/client.ts, tests/helpers.ts
//   here → game repo:   server/lobby.ts as tests/fixtures/lobby.ts (the reference server its
//                       online-sync tests play against)
//
//   npm run sync                            (the game repo next to this one: ../mana-chess-frontend)
//   npm run sync -- path/to/mana-chess-frontend
//
// Afterwards commit both repositories; both images then carry the same version.
// ─────────────────────────────────────────────────────────────────────────────
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildId } from './build-id.mjs';

const here = process.cwd();
const game = resolve(process.argv[2] ?? process.env.MANA_FRONTEND ?? join(here, '..', 'mana-chess-frontend'));
if (!existsSync(join(game, 'src', 'engine')) || !existsSync(join(game, 'src', 'net', 'protocol.ts'))) {
  console.error(`Nem találom a játék repóját itt: ${game}\nAdd meg az útvonalát: npm run sync -- ../mana-chess-frontend`);
  process.exit(1);
}
const before = buildId(here);

// the rules, the messages, the client (the HTTP tests use it) and the test helpers
rmSync(join(here, 'src', 'engine'), { recursive: true, force: true });
cpSync(join(game, 'src', 'engine'), join(here, 'src', 'engine'), { recursive: true });
mkdirSync(join(here, 'src', 'net'), { recursive: true });
for (const f of ['protocol.ts', 'client.ts']) cpSync(join(game, 'src', 'net', f), join(here, 'src', 'net', f));
cpSync(join(game, 'tests', 'helpers.ts'), join(here, 'tests', 'helpers.ts'));

// this server's rooms, for the game's sync tests (imports one folder deeper)
const lobby = readFileSync(join(here, 'server', 'lobby.ts'), 'utf8').replace(/from '\.\.\/src\//g, "from '../../src/");
mkdirSync(join(game, 'tests', 'fixtures'), { recursive: true });
writeFileSync(
  join(game, 'tests', 'fixtures', 'lobby.ts'),
  `// Copied from mana-chess-backend/server/lobby.ts by its \`npm run sync\` – do not edit here.\n${lobby}`,
);

const after = buildId(here);
const theirs = buildId(game);
console.log(`Szabályok átmásolva innen: ${game}`);
console.log(`Verzió: ${before} → ${after} (a játék repója: ${theirs})${after === theirs ? ' – egyezik.' : ' – ELTÉR!'}`);
if (after !== theirs) process.exit(1);
