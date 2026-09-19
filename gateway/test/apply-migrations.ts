import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Setup files run outside the per-file storage isolation and may run more than
// once; applyD1Migrations only applies what is not yet applied.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);
