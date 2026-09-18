#!/usr/bin/env node
/**
 * Nightly D1 backup (W4-D): export the database to SQL, gzip it, upload it to R2.
 *
 *   node scripts/backup.mjs                      # remote D1 → r2://mambo-jambo-photos/backups/d1/…
 *   node scripts/backup.mjs --dry-run            # print the plan, call nothing
 *   node scripts/backup.mjs --local --config /tmp/cf/wrangler.jsonc   # prove the script offline
 *
 * Objects (dates are UTC, matching the GitHub Action's clock):
 *   backups/d1/daily/<YYYY-MM-DD>.sql.gz     every night, expired after 30 days by the bucket's
 *                                            lifecycle rule (docs/runbook.md → "Backups")
 *   backups/d1/monthly/<YYYY-MM>.sql.gz      the same dump again on the 1st, under a prefix the
 *                                            lifecycle rule does not touch, so one copy per month
 *                                            survives (R2 lifecycle rules cannot express "keep the
 *                                            1st", so the monthly copy is made here instead)
 *
 * They share the photo bucket because the Worker already binds it and R2 has no per-prefix billing;
 * a dedicated `mambo-jambo-backups` bucket is the safer choice if the crew ever gets a token that
 * may read photos but not backups (see the runbook). Nothing in an object here is served publicly:
 * the Worker only signs keys under `sessions/`.
 *
 * Options: --database <name> --bucket <name> --prefix <key prefix> --date <YYYY-MM-DD>
 *          --out-dir <dir> --keep (leave the local .sql/.sql.gz) --skip-upload --dry-run
 *          --local --config <wrangler.jsonc> (both are passed straight to wrangler)
 * Credentials: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment (the Action's
 * repository secrets), or an interactive `wrangler login` locally.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULTS = { database: 'mambo-jambo-photos', bucket: 'mambo-jambo-photos', prefix: 'backups/d1' };
const FLAGS = { keep: 'keep', 'dry-run': 'dryRun', 'skip-upload': 'skipUpload', local: 'local' };
const VALUES = { database: 'database', bucket: 'bucket', prefix: 'prefix', date: 'date', 'out-dir': 'outDir', config: 'config' };

export function parseBackupArgs(argv) {
  const options = { ...DEFAULTS, local: false, keep: false, dryRun: false, skipUpload: false };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--')) throw new Error(`unknown option: ${argv[i]}`);
    if (FLAGS[name]) { options[FLAGS[name]] = true; continue; }
    if (!VALUES[name]) throw new Error(`unknown option: ${argv[i]}`);
    const value = argv[i + 1]; i += 1;
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    options[VALUES[name]] = value;
  }
  if (options.date && !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) throw new Error('--date must be YYYY-MM-DD');
  return options;
}

// One dump, two possible keys. The daily prefix is what the 30-day lifecycle rule expires.
export function backupKeys(now = new Date(), prefix = DEFAULTS.prefix) {
  const base = prefix.replace(/\/+$/, '');
  const date = now.toISOString().slice(0, 10);
  return { daily: `${base}/daily/${date}.sql.gz`, monthly: date.endsWith('-01') ? `${base}/monthly/${date.slice(0, 7)}.sql.gz` : null, date };
}

// `npx wrangler …`. Its stderr is inherited, so a GitHub Action log shows wrangler's own progress
// and errors verbatim; stdout is captured (callers parse `--json` output) and only echoed when the
// command fails, so a restore drill's query results do not bury the report.
export function wranglerRunner({ cwd } = {}) {
  return (args) => new Promise((resolve, reject) => {
    const child = spawn('npx', ['--no-install', 'wrangler', ...args], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve({ stdout });
      process.stderr.write(stdout.slice(-2000));
      reject(new Error(`wrangler ${args.slice(0, 2).join(' ')} failed (exit ${code})`));
    });
  });
}

// A dump that is empty, or that carries no statement at all, means the export did not happen —
// uploading it would overwrite nothing (each key is unique per day) but would hide the failure.
function summarise(sql) {
  if (!sql.trim()) throw new Error('the export produced an empty dump — refusing to upload it');
  const tables = (sql.match(/^CREATE TABLE /gm) || []).length;
  const rows = (sql.match(/^INSERT INTO /gm) || []).length;
  if (!tables) throw new Error('the export contains no CREATE TABLE — refusing to upload it');
  return { tables, rows };
}

export async function runBackup(options = {}, { wrangler = wranglerRunner(), log = console.log } = {}) {
  const settings = { ...DEFAULTS, ...options };
  const now = settings.date ? new Date(`${settings.date}T00:00:00Z`) : new Date();
  const keys = backupKeys(now, settings.prefix);
  // Outside the repo by default, so a hand-run never leaves a database dump in the working tree
  // (and never needs a .gitignore entry); --out-dir puts it somewhere deliberate.
  const outDir = settings.outDir || join(tmpdir(), 'soi-d1-backup');
  const sqlPath = join(outDir, `${keys.date}.sql`), gzPath = `${sqlPath}.gz`;
  const scope = settings.local ? ['--local'] : ['--remote'];
  const config = settings.config ? ['--config', settings.config] : [];
  if (settings.dryRun) {
    log(`[dry run] wrangler d1 export ${settings.database} ${scope[0]} --output ${sqlPath}`);
    for (const key of [keys.daily, keys.monthly].filter(Boolean)) log(`[dry run] wrangler r2 object put ${settings.bucket}/${key} --file ${gzPath}`);
    return { keys, uploaded: [], dryRun: true };
  }

  await mkdir(outDir, { recursive: true });
  await rm(sqlPath, { force: true }); await rm(gzPath, { force: true });
  // `d1 export` writes the file itself; --output is required by wrangler.
  await wrangler(['d1', 'export', settings.database, scope[0], '--output', sqlPath, ...config]);
  const sql = await readFile(sqlPath, 'utf8');
  const counts = summarise(sql);

  // Streamed so a multi-hundred-megabyte dump never sits in memory; the hash is taken over the
  // gzip, which is what the object stores (`wrangler r2 object get` + sha256sum verifies it).
  const hash = createHash('sha256');
  await pipeline(createReadStream(sqlPath), createGzip({ level: 9 }), async function* (compressed) { for await (const chunk of compressed) { hash.update(chunk); yield chunk; } }, createWriteStream(gzPath));
  const bytes = { sql: (await stat(sqlPath)).size, gz: (await stat(gzPath)).size };
  const sha256 = hash.digest('hex');
  log(`D1 export: ${counts.tables} tables, ${counts.rows} insert statements, ${bytes.sql} B → ${bytes.gz} B gzip (sha256 ${sha256})`);

  const uploaded = [];
  if (!settings.skipUpload) {
    for (const key of [keys.daily, keys.monthly].filter(Boolean)) {
      await wrangler(['r2', 'object', 'put', `${settings.bucket}/${key}`, '--file', gzPath, '--content-type', 'application/gzip', ...scope, ...config]);
      uploaded.push(key); log(`uploaded ${settings.bucket}/${key}`);
    }
  }
  if (!settings.keep) { await rm(sqlPath, { force: true }); await rm(gzPath, { force: true }); }
  return { keys, uploaded, bytes, sha256, ...counts, files: settings.keep ? { sql: sqlPath, gz: gzPath } : null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runBackup(parseBackupArgs(process.argv.slice(2))); }
  catch (error) { console.error(`backup failed: ${error.message}`); process.exitCode = 1; }
}
export const scriptPath = fileURLToPath(import.meta.url);
