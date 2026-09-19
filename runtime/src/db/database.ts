import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, ErrorCode, errorMessage } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';

/**
 * Local persistence.
 *
 * Built on Node's own `node:sqlite` rather than a native addon. That is a
 * deliberate supply-chain decision for a process that holds wallet keys: no
 * compiler in the container image, no node-gyp step that can fail on an
 * operator's machine, and one fewer third-party package with native code in
 * the same address space as the vault.
 *
 * The thin wrapper below keeps the call sites typed, since `node:sqlite`
 * returns `unknown` rows.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Values SQLite can bind. */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

export interface Statement<Params extends SqlValue[], Row> {
  run(...params: Params): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: Params): Row | undefined;
  all(...params: Params): Row[];
}

export interface Db {
  prepare<Params extends SqlValue[] = SqlValue[], Row = Record<string, unknown>>(
    sql: string,
  ): Statement<Params, Row>;
  exec(sql: string): void;
  pragma(statement: string): unknown;
  /** Run `fn` inside a transaction, rolling back if it throws. */
  transaction<T>(fn: () => T): () => T;
  readonly open: boolean;
  close(): void;
}

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
 *  - WAL keeps readers from blocking the writer.
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

  const handle = new DatabaseSync(options.file);
  const db = wrap(handle);

  db.pragma(`journal_mode = ${inMemory ? 'MEMORY' : 'WAL'}`);
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  if (options.migrate !== false) {
    const applied = migrate(db);
    if (applied.length > 0) {
      log.info({ applied, file: inMemory ? ':memory:' : options.file }, 'applied migrations');
    }
  }

  return db;
}

function wrap(handle: DatabaseSync): Db {
  // SQLite has no nested BEGIN, and node:sqlite does not expose the autocommit
  // flag, so the wrapper tracks nesting itself: only the outermost call issues
  // BEGIN/COMMIT.
  let depth = 0;

  return {
    prepare<Params extends SqlValue[] = SqlValue[], Row = Record<string, unknown>>(sql: string) {
      const statement = handle.prepare(sql);
      return {
        run: (...params: Params) => statement.run(...(params as unknown as never[])),
        get: (...params: Params) =>
          statement.get(...(params as unknown as never[])) as Row | undefined,
        all: (...params: Params) => statement.all(...(params as unknown as never[])) as Row[],
      };
    },

    exec(sql: string) {
      handle.exec(sql);
    },

    pragma(statement: string) {
      return handle.prepare(`PRAGMA ${statement}`).get();
    },

    /**
     * Wrap `fn` in a transaction.
     *
     * Returns a callable rather than running immediately, mirroring the shape
     * the call sites already use. Nested calls reuse the outer transaction:
     * SQLite has no nested BEGIN, and a savepoint would add complexity ATRA
     * does not currently need.
     */
    transaction<T>(fn: () => T): () => T {
      return () => {
        const outermost = depth === 0;
        if (outermost) handle.exec('BEGIN');
        depth += 1;
        try {
          const result = fn();
          depth -= 1;
          if (outermost) handle.exec('COMMIT');
          return result;
        } catch (error) {
          depth -= 1;
          if (outermost) {
            try {
              handle.exec('ROLLBACK');
            } catch {
              // A rollback failure would mask the original error, which is the
              // one the caller actually needs to see.
            }
          }
          throw error;
        }
      };
    },

    get open() {
      return handle.isOpen;
    },

    close() {
      handle.close();
    },
  };
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
