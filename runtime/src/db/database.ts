import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, ErrorCode, errorMessage } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';

export type { Db };

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface OpenDatabaseOptions {
  /** Absolute path to the SQLite file, or ':memory:' for tests. */
  file: string;
  /** Apply pending migrations on open. Default true. */
  migrate?: boolean;
}

/**
 * Open the local database and bring it up to the current schema.
 *
 * Pragmas are chosen for a service that runs unattended for weeks:
 *  - WAL keeps readers from blocking the writer during a long sync.
 *  - `synchronous = FULL` because this database records money movements; the
 *    throughput cost is irrelevant at ATRA's transaction rate.
 *  - `foreign_keys` is off by default in SQLite and must be enabled per
 *    connection.
 */
export function openDatabase(options: OpenDatabaseOptions): Db {
  const log = childLogger('db');
  const inMemory = options.file === ':memory:';

  if (!inMemory) {
    mkdirSync(dirname(options.file), { recursive: true });
  }

  const db = new Database(options.file);

  db.pragma('journal_mode = ' + (inMemory ? 'MEMORY' : 'WAL'));
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('trusted_schema = OFF');

  if (options.migrate !== false) {
    const applied = migrate(db);
    if (applied.length > 0) {
      log.info({ applied, file: inMemory ? ':memory:' : options.file }, 'applied migrations');
    }
  }

  return db;
}

interface MigrationFile {
  name: string;
  sql: string;
}

function loadMigrations(): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'));
  } catch (cause) {
    throw new AppError(ErrorCode.INTERNAL, 'Migration directory is unreadable', {
      cause,
      details: { dir: MIGRATIONS_DIR },
    });
  }

  return entries
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

/**
 * Apply every migration that has not run yet, each in its own transaction.
 * Returns the names applied during this call.
 */
export function migrate(db: Db): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (' +
      'name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );

  const done = new Set(
    db
      .prepare<[], { name: string }>('SELECT name FROM schema_migrations')
      .all()
      .map((row) => row.name),
  );

  const applied: string[] = [];
  const record = db.prepare<[string, string]>(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)',
  );

  for (const migration of loadMigrations()) {
    if (done.has(migration.name)) continue;

    const run = db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.name, new Date().toISOString());
    });

    try {
      run();
    } catch (cause) {
      throw new AppError(ErrorCode.INTERNAL, `Migration ${migration.name} failed`, {
        cause,
        details: { migration: migration.name, reason: errorMessage(cause) },
      });
    }

    applied.push(migration.name);
  }

  return applied;
}

/** Flush WAL and close. Safe to call more than once. */
export function closeDatabase(db: Db): void {
  if (!db.open) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // A checkpoint failure must not prevent shutdown; the WAL is replayed on
    // the next open.
  }
  db.close();
}
