// ─────────────────────────────────────────────────────────────────────────────
// `node backend.mjs` – the Mana Chess backend: accounts, decks, friends, rooms and the control
// panel (http://…/admin). Plain HTTP: for HTTPS from anywhere put it behind Nginx Proxy Manager.
//
//   node backend.mjs                     port 8787, data in ./data next to this file
//   node backend.mjs --port 9000         another port
//   node backend.mjs --data D:\mana      keep the data somewhere else
//   node backend.mjs --setup             a new one-time admin setup code (lost admin password)
//   node backend.mjs --no-open           do not open the control panel on the first start
//
// The same settings as environment variables (Docker): PORT, HOST, MANA_DATA (the data folder),
// MANA_PUBLIC_URL (the address players type in, shown in the control panel), MANA_SETUP=1.
// Needs Node.js 18 or newer, nothing else.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_ID, DEFAULT_PORT } from '../src/net/protocol';
import { startBackend } from './index';

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes('--help') || args.includes('-h')) {
  console.log('Használat: node backend.mjs [--port 8787] [--data <mappa>] [--host 0.0.0.0] [--setup] [--no-open]');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(arg('--data') ?? (process.env.MANA_DATA || join(here, 'data')));
const dataFile = join(dataDir, 'mana-chess.json');
const port = Number(arg('--port') ?? process.env.PORT ?? DEFAULT_PORT) || DEFAULT_PORT;
const host = arg('--host') ?? (process.env.HOST || undefined);
const publicUrls = (process.env.MANA_PUBLIC_URL ?? '')
  .split(/[\s,]+/)
  .map((u) => u.trim().replace(/\/+$/, ''))
  .filter((u) => /^https?:\/\/[^\s/]+/.test(u));
const setupWanted = args.includes('--setup') || /^(1|true|yes|igen)$/i.test(process.env.MANA_SETUP ?? '');
/** In a container this machine's own addresses are Docker-internal – useless to players. */
const container = existsSync('/.dockerenv') || existsSync('/run/.containerenv');

// the data folder must be writable – say so plainly instead of failing on the first save
try {
  mkdirSync(dataDir, { recursive: true });
  accessSync(dataDir, constants.W_OK | constants.R_OK);
} catch (e) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  console.error(
    [
      '',
      `  Az adatmappa nem írható: ${dataDir}`,
      `  (${(e as Error).message})`,
      ...(container
        ? [
            `  A konténer felhasználója: uid ${uid}. A docker-compose.yml kötete (data:/data) magától jó;`,
            `  ha egy mappát csatoltál a /data-ra (pl. ./data:/data), a szerveren: sudo chown -R ${uid}:${uid} ./data`,
          ]
        : uid !== null
          ? [`  A szerver felhasználója (uid ${uid}) nem írhat ide – adj rá jogot, vagy válassz másik mappát: --data <mappa>`]
          : ['  Adj rá írási jogot, vagy válassz másik mappát: --data <mappa>']),
      '',
    ].join('\n'),
  );
  process.exit(1);
}
const time = () => new Date().toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function openBrowser(url: string): void {
  try {
    const [cmd, cmdArgs] = process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const child = spawn(cmd as string, cmdArgs as string[], { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no browser – the address is printed anyway
  }
}

startBackend({
  port,
  portTries: arg('--port') || process.env.PORT ? 1 : 10,
  host,
  publicUrls,
  hideLanAddresses: container,
  dataFile,
  log: (msg) => console.log(`  [${time()}] ${msg}`),
})
  .then((s) => {
    if (setupWanted) s.accounts.newSetupCode();
    const local = `http://localhost:${s.port}`;
    const code = s.accounts.setupCode;
    // in a container the machine's own addresses are Docker-internal: say what to use instead
    const where = publicUrls.length
      ? publicUrls.map((u, i) => `  ${i === 0 ? 'A játékban megadandó: ' : '                      '}${u}`)
      : container
        ? [
            '  Konténerben fut: a játékban a szerver gépének címét add meg (pl. 192.168.1.10:8787),',
            '  interneten a https-es címét. A vezérlőpulton megjelenő cím: MANA_PUBLIC_URL.',
          ]
        : s.lanUrls.length
          ? s.lanUrls.map((u, i) => `  ${i === 0 ? 'A helyi hálózaton:   ' : '                      '}${u}${i === 0 ? '   <- ezt add meg a játékban' : ''}`)
          : ['  A helyi hálózaton:   (nem találtam hálózati címet)'];
    const lines = [
      '',
      '  =====================================================',
      '    MANA CHESS backend fut',
      '  =====================================================',
      '',
      `  Ezen a gépen:        ${local}`,
      ...where,
      `  Vezérlőpult:         ${local}/admin${container ? '   (a konténeren kívülről: http://<a szerver címe>:<port>/admin)' : ''}`,
      '',
      ...(code
        ? [
            '  -----------------------------------------------------',
            `    BEÁLLÍTÓKÓD:  ${code}`,
            ...(s.accounts.hasAdmin()
              ? ['    Nyisd meg a vezérlőpultot, és ezzel a kóddal adj új', '    jelszót az adminisztrátori fiókodnak.']
              : ['    Nyisd meg a vezérlőpultot, és ezzel a kóddal hozd létre', '    az adminisztrátori fiókot.']),
            '  -----------------------------------------------------',
            '',
          ]
        : []),
      '  Interneten HTTPS-sel: Nginx Proxy Manager -> Proxy Host -> Forward: ennek a gépnek',
      `  (vagy konténernek) a címe, port ${s.port}, SSL: Let's Encrypt.`,
      ...(container ? [] : ['  Ha a Windows tűzfal rákérdez, engedélyezd a Node.js-t.']),
      '',
      `  Adatok: ${dataFile}`,
      `  Verzió: ${BUILD_ID}`,
      // in a container: in the background (compose up -d) or in the terminal (compose run … --setup)
      container ? (process.stdout.isTTY ? '  Leállítás: Ctrl+C' : '  Leállítás: docker compose stop') : '  Leállítás: Ctrl+C (vagy zárd be ezt az ablakot)',
      '',
    ];
    console.log(lines.join('\n'));
    if (code && !args.includes('--no-open')) openBrowser(`${local}/admin`);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      console.log('\n  Backend leállítva (az adatok elmentve).');
      s.close().finally(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('SIGHUP', stop); // the console window is closed (Windows)
    process.on('exit', () => s.store.flush());
  })
  .catch((e: NodeJS.ErrnoException) => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    console.error(
      e.code === 'EADDRINUSE'
        ? `\n  A(z) ${port}. port foglalt – fut már egy szerver? Próbáld: node backend.mjs --port ${port + 100}\n`
        : e.code === 'MANA_DATA_UNREADABLE'
          ? [
              '',
              `  ${e.message}`,
              '  Üres adatokkal nem indulok el, hogy egy fiók se vesszen el; a fájlhoz nem nyúltam.',
              ...(container
                ? [
                    `  A fájlnak a konténer felhasználójáé (uid ${uid}) kell lennie. Mentés visszaállítása a -a kapcsolóval:`,
                    '    docker compose stop backend',
                    '    docker compose cp -a <mentés.json> backend:/data/mana-chess.json',
                    '    docker compose up -d',
                  ]
                : [`  Adj rá olvasási és írási jogot a szerver felhasználójának${uid !== null ? ` (uid ${uid})` : ''}.`]),
              '',
            ].join('\n')
          : `\n  A backend nem indult el: ${e.message}\n`,
    );
    process.exit(1);
  });
