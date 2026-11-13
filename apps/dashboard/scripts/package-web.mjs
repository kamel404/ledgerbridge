// Turns the `next build` output into the folder CDK uploads as the dashboard's
// Lambda Web Function: apps/dashboard/dist-web/ (git-ignored).
//
//   dist-web/
//     index.js                  entry point the Web Function runs (its default)
//     apps/dashboard/server.js  Next's standalone server
//     apps/dashboard/.next/     server code + static JS/CSS
//     node_modules/             only the files the server uses
//
// Run by `npm run build:lambda -w dashboard` (and the root `npm run deploy`).

import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const app = path.resolve(import.meta.dirname, '..');
const standalone = path.join(app, '.next', 'standalone');
const out = path.join(app, 'dist-web');

if (!existsSync(path.join(standalone, 'apps', 'dashboard', 'server.js'))) {
  console.error('No standalone build found. Run `next build` first (next.config.ts sets output: "standalone").');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
// dereference: copy real files, not symlinks/junctions (Windows can create those).
cpSync(standalone, out, { recursive: true, dereference: true });
// The standalone server doesn't include the static chunks; it serves them if they're here.
cpSync(path.join(app, '.next', 'static'), path.join(out, 'apps', 'dashboard', '.next', 'static'), {
  recursive: true,
  dereference: true,
});
if (existsSync(path.join(app, 'public'))) {
  cpSync(path.join(app, 'public'), path.join(out, 'apps', 'dashboard', 'public'), { recursive: true, dereference: true });
}
// sharp (next/image optimization) gets traced with the native binary of the machine
// that built it, e.g. Windows. The dashboard has no images, so leave it out; Next
// only loads it on demand for image optimization.
for (const dir of ['sharp', '@img']) rmSync(path.join(out, 'node_modules', dir), { recursive: true, force: true });
// Local env files must never be shipped: on AWS, secrets come from Secrets Manager.
for (const f of ['.env', '.env.local', '.env.production', '.env.production.local']) {
  rmSync(path.join(out, 'apps', 'dashboard', f), { force: true });
}

writeFileSync(
  path.join(out, 'index.js'),
  [
    '// Entry point of the dashboard Web Function (made by scripts/package-web.mjs).',
    '// Listen on every interface inside the Lambda sandbox; Lambda sets HOSTNAME to the',
    "// machine name, which Next would otherwise bind to. PORT: Lambda's, else Next's 3000.",
    "process.env.HOSTNAME = '0.0.0.0';",
    "import('./apps/dashboard/server.js');",
    '',
  ].join('\n'),
);
writeFileSync(path.join(out, 'package.json'), JSON.stringify({ private: true, type: 'commonjs' }, null, 2) + '\n');

console.log(`Dashboard Web Function package ready: ${path.relative(process.cwd(), out)}`);
