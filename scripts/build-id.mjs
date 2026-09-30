// The rules' fingerprint: a hash of the engine and the online protocol. The game page and the
// online server both carry it, so a server only lets in pages that run exactly the same rules.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export function buildId(root = process.cwd()) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|json)$/.test(name)) files.push(p);
    }
  };
  walk(join(root, 'src', 'engine'));
  files.push(join(root, 'src', 'net', 'protocol.ts'));
  const h = createHash('sha256');
  // line endings do not change the rules (a checkout on Windows may use CRLF)
  for (const f of files) h.update(relative(root, f).replace(/\\/g, '/')).update(readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));
  return h.digest('hex').slice(0, 10);
}
