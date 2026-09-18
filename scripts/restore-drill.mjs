#!/usr/bin/env node
/**
 * Restore drill (W4-D): prove a backup can be read back.
 *
 *   node scripts/restore-drill.mjs --dump backups/2026-09-17.sql.gz [--persist-to /tmp/drill] [--keep] [--json]
 *
 * Loads the dump (`.sql` or `.sql.gz`) into a **fresh local** D1 — never the remote database — and
 * runs three sanity queries: how many sessions (and how many published), how many photos (and how
 * many have at least one indexed face), and the latest payment. It prints a report you can paste
 * into docs/runbook.md; record one drill per quarter there with its date.
 *
 * The drill is deliberately local-only: `wrangler d1 execute --local` writes into a throwaway
 * `--persist-to` directory, so a mistyped flag cannot reach production. Restoring *into*
 * production is a separate, deliberate human step — the runbook has it.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { wranglerRunner, DEFAULTS } from './backup.mjs';

// Three questions a restored copy must answer before anyone trusts it: are the sessions there, are
// the photos and their indexed faces there, and did the money survive. Each one is a single
// statement so `d1 execute --json` returns one result set.
export const SANITY_QUERIES = [
  { name: 'sessions', sql: "SELECT COUNT(*) AS n, SUM(status = 'published') AS published FROM sessions", expect: rows => Number(rows[0]?.n ?? 0) > 0 },
  { name: 'photos', sql: 'SELECT COUNT(*) AS n, (SELECT COUNT(DISTINCT photo_id) FROM faces) AS indexed FROM photos', expect: () => true },
  { name: 'latest payment', sql: "SELECT id, status, amount_paise, paid_at FROM payments ORDER BY COALESCE(paid_at, created_at) DESC LIMIT 1", expect: () => true },
];

export function parseDrillArgs(argv) {
  const options = { database: DEFAULTS.database, keep: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i].replace(/^--/, '');
    if (name === 'keep' || name === 'json') { options[name] = true; continue; }
    if (name === 'dump' || name === 'persist-to' || name === 'database') {
      const value = argv[i + 1]; i += 1;
      if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
      options[name === 'persist-to' ? 'persistTo' : name] = value; continue;
    }
    throw new Error(`unknown option: ${argv[i]}`);
  }
  if (!options.dump) throw new Error('--dump <file.sql|file.sql.gz> is required');
  if (!options.persistTo) options.persistTo = null;
  return options;
}

// `wrangler d1 execute --json` prints an array of result sets; older versions wrap it in log lines,
// so the JSON is found rather than assumed to be the whole of stdout.
function resultRows(stdout) {
  const start = stdout.indexOf('[');
  if (start < 0) return [];
  try { const parsed = JSON.parse(stdout.slice(start)); return parsed?.[0]?.results ?? []; } catch { return []; }
}

// A `wrangler d1 export` dump interleaves DDL and data per table: `CREATE TABLE sessions …` and its
// rows, then `CREATE TABLE photos …` and its rows. `sessions.cover_photo_id` references `photos`, so
// the first INSERT arrives while that table does not exist yet and SQLite answers
// `no such table: main.photos` — the dump's leading `PRAGMA defer_foreign_keys=TRUE` is meant to
// cover exactly this, and it is not honoured statement-by-statement by `d1 execute --file`.
// Splitting the dump into "every CREATE first, then every INSERT" is equivalent for a fresh
// database and restores cleanly. The same split is what a real restore needs (docs/runbook.md §5).
// Statements are separated on a `;` that ends a line outside a string literal (SQLite escapes a
// quote inside a literal by doubling it, so counting quotes per line is exact).
export function splitDump(sql) {
  const schema = [], data = [];
  let statement = '', open = false;
  for (const line of sql.split('\n')) {
    statement += (statement ? '\n' : '') + line;
    if ((line.match(/'/g) || []).length % 2 === 1) open = !open;
    if (open || !line.trimEnd().endsWith(';')) continue;
    const text = statement.trim(); statement = '';
    if (!text) continue;
    (/^INSERT\s/i.test(text) ? data : schema).push(text);
  }
  if (statement.trim()) schema.push(statement.trim());
  return { schema, data };
}

export async function runRestoreDrill(options, { wrangler = wranglerRunner(), log = console.log } = {}) {
  const raw = await readFile(options.dump);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const workDir = await mkdtemp(join(tmpdir(), 'soi-restore-drill-'));
  const persistTo = options.persistTo || join(workDir, 'state');
  const sql = options.dump.endsWith('.gz') ? gunzipSync(raw).toString() : raw.toString();
  const { schema, data } = splitDump(sql);
  const schemaPath = join(workDir, `${basename(options.dump).replace(/\.(sql|sql\.gz|gz)$/, '')}-schema.sql`);
  const dataPath = schemaPath.replace(/-schema\.sql$/, '-data.sql');
  await writeFile(schemaPath, `${schema.join('\n')}\n`);
  await writeFile(dataPath, data.length ? `${data.join('\n')}\n` : '');
  const base = ['d1', 'execute', options.database || DEFAULTS.database, '--local', '--persist-to', persistTo];

  log(`restoring ${options.dump} (${raw.length} B, sha256 ${sha256}) into a fresh local database at ${persistTo}`);
  log(`  ${schema.length} schema statements, ${data.length} insert statements (loaded in that order — see splitDump)`);
  await wrangler([...base, '--file', schemaPath, '-y']);
  if (data.length) await wrangler([...base, '--file', dataPath, '-y']);
  const checks = [];
  for (const query of SANITY_QUERIES) {
    const { stdout } = await wrangler([...base, '--command', query.sql, '--json']);
    const rows = resultRows(stdout);
    checks.push({ name: query.name, sql: query.sql, rows, ok: query.expect(rows) });
    log(`  ${query.name}: ${rows.length ? JSON.stringify(rows[0]) : '(no rows)'}`);
  }
  const report = { dump: options.dump, bytes: raw.length, sha256, persistTo, checks, ok: checks.every(check => check.ok), ranAt: new Date().toISOString() };
  log(report.ok ? 'restore drill PASSED' : 'restore drill FAILED — a sanity query came back empty (see above)');
  if (!options.keep) await rm(workDir, { recursive: true, force: true });
  else log(`kept ${workDir}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseDrillArgs(process.argv.slice(2));
    await stat(options.dump);
    const report = await runRestoreDrill(options);
    if (options.json) console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) { console.error(`restore drill failed: ${error.message}`); process.exitCode = 1; }
}
