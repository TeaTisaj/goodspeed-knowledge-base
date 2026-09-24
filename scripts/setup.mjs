#!/usr/bin/env node
/**
 * One-command setup.
 *
 * Every check here exists because its absence produces a confusing failure
 * later: a Node version the Nest CLI refuses to run on, a stopped Docker
 * daemon, a port already taken by another Supabase project. Failing early with
 * a message that names the fix is the whole point.
 */
import { execSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const info = (m) => console.log(`  \x1b[2m${m}\x1b[0m`);
const fail = (m, fix) => {
  console.error(`\n  \x1b[31m✗ ${m}\x1b[0m`);
  if (fix) console.error(`    ${fix}\n`);
  process.exit(1);
};

/**
 * Runs a binary from the workspace's own node_modules/.bin.
 *
 * Deliberately not `spawnSync('pnpm', ['exec', ...])`: shelling out to pnpm
 * from a script pnpm itself launched makes corepack try to install pnpm
 * globally and append to the user's shell profile. Calling the local binary
 * directly is both faster and free of side effects.
 */
function runLocal(bin, args) {
  const exe = resolve(root, 'node_modules', '.bin', bin);
  if (!existsSync(exe)) fail(`${bin} is not installed.`, 'Run `pnpm install` first.');
  const r = spawnSync(exe, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) fail(`${bin} ${args.join(' ')} failed.`);
}

console.log('\nSetting up the knowledge base\n');

// --- 1. Node --------------------------------------------------------------
const [major, minor] = process.versions.node.split('.').map(Number);
const nodeOk = (major === 22 && minor >= 22) || (major === 24 && minor >= 15) || major >= 26;
if (!nodeOk) {
  fail(
    `Node ${process.versions.node} is too old.`,
    'Needs ^22.22.3, ^24.15.0 or >=26 (a NestJS CLI requirement).\n' +
      '    With fnm or nvm installed, `fnm use` / `nvm use` picks up .nvmrc.',
  );
}
ok(`Node ${process.versions.node}`);

// --- 2. Docker ------------------------------------------------------------
try {
  execSync('docker info', { stdio: 'ignore' });
  ok('Docker is running');
} catch {
  fail('Docker is not running.', 'Start Docker Desktop, then run this again.');
}

// --- 3. Ports -------------------------------------------------------------
// Supabase uses fixed ports, so another local Supabase project will collide.
const busy = [];
for (const port of [54321, 54322, 54323]) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { stdio: 'pipe' }).toString();
    if (out.trim()) busy.push(port);
  } catch {
    // Nothing listening: lsof exits non-zero, which is the good case.
  }
}
if (busy.length > 0) {
  info(`Ports ${busy.join(', ')} are in use -- assuming this project's Supabase is already running.`);
  info('If another Supabase project is running, stop it first (`supabase stop` in that folder).');
}

// --- 4. .env --------------------------------------------------------------
const envPath = resolve(root, '.env');
if (!existsSync(envPath)) {
  copyFileSync(resolve(root, '.env.example'), envPath);
  ok('Created .env from .env.example');
} else {
  ok('.env already exists, left untouched');
}

/**
 * The web app needs its own file, and this is not optional.
 *
 * Next.js resolves env per app directory and does not read a monorepo root
 * `.env`, so `apps/web` cannot see the root file no matter what is in it.
 * Without this the browser client is constructed with `undefined` Supabase
 * credentials and sign-in fails on the first click -- with nothing in any log
 * to say why. Both files are gitignored, so only this script can create them.
 */
const webEnvPath = resolve(root, 'apps', 'web', '.env.local');
if (!existsSync(webEnvPath)) {
  copyFileSync(resolve(root, 'apps', 'web', '.env.example'), webEnvPath);
  ok('Created apps/web/.env.local from apps/web/.env.example');
} else {
  ok('apps/web/.env.local already exists, left untouched');
}

// --- 5. Supabase ----------------------------------------------------------
console.log('\nStarting Supabase (first run downloads images, this can take a few minutes)\n');
runLocal('supabase', ['start']);

// --- 6. Migrations --------------------------------------------------------
console.log('\nApplying migrations\n');
runLocal('supabase', ['db', 'reset', '--no-seed']);

// --- 7. Sync local keys into .env ----------------------------------------
// `supabase start` prints project-local keys. They are identical on every
// machine and are not secrets, but writing them means the reviewer never has
// to copy anything by hand.
try {
  const status = execSync(`${resolve(root, 'node_modules', '.bin', 'supabase')} status -o json`, {
    cwd: root,
    stdio: 'pipe',
  })
    .toString()
    .trim();
  const parsed = JSON.parse(status.slice(status.indexOf('{')));
  const publishable = parsed.PUBLISHABLE_KEY ?? parsed.ANON_KEY;

  /** Replaces a key in place, or appends it when the file does not have it yet. */
  const set = (contents, key, value) =>
    value === undefined || value === null
      ? contents
      : contents.match(new RegExp(`^${key}=.*$`, 'm'))
        ? contents.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`)
        : `${contents}\n${key}=${value}`;

  let env = readFileSync(envPath, 'utf8');
  env = set(env, 'SUPABASE_PUBLISHABLE_KEY', publishable);
  env = set(env, 'SUPABASE_SECRET_KEY', parsed.SECRET_KEY ?? parsed.SERVICE_ROLE_KEY);
  env = set(env, 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', publishable);
  writeFileSync(envPath, env);
  ok('Wrote local Supabase keys into .env');

  // Same keys, second file. Kept in sync here rather than documented as a
  // manual step, because a stale browser key fails in a way that looks like
  // broken auth rather than broken configuration.
  let webEnv = readFileSync(webEnvPath, 'utf8');
  webEnv = set(webEnv, 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', publishable);
  writeFileSync(webEnvPath, webEnv);
  ok('Wrote local Supabase keys into apps/web/.env.local');
} catch {
  info('Could not read `supabase status`; env keys left as-is (defaults are usually correct).');
}

// --- 8. Build shared packages --------------------------------------------
console.log('\nBuilding shared packages\n');
runLocal('turbo', ['run', 'build', '--filter=@kb/contracts', '--filter=@kb/ai', '--filter=@kb/rag']);

// --- 9. Seed --------------------------------------------------------------
console.log('\nSeeding demo data\n');
const seed = spawnSync(process.execPath, ['scripts/seed.mjs'], { cwd: root, stdio: 'inherit' });
if (seed.status !== 0) fail('Seeding failed.');

console.log(`
\x1b[32mReady.\x1b[0m

  pnpm dev        API on :3001, web on :3000

  Sign in at http://localhost:3000
    demo@example.com   / demo-password-123
    second@example.com / demo-password-123   (separate account, proves isolation)

  Runs with no AI keys by default. To use a real provider, set AI_CHAT_PROVIDER
  and AI_EMBEDDING_PROVIDER in .env -- see the README.
`);
