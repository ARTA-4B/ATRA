import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd (the real Workers runtime) with a local D1, the Hub
// Durable Object and real WebSockets. Secrets are test values; nothing here
// reaches the network: api.telegram.org is stubbed in every test file.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Deliberately not shaped like a real bot token: the repo's secret scan
            // (ci.yml) rejects anything that looks like one, test value or not.
            TELEGRAM_BOT_TOKEN: '42:not-a-real-bot-token',
            TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
            TOKEN_PEPPER: 'test-token-pepper-not-for-production',
            ADMIN_TOKEN: 'test-admin-token',
            BOT_USERNAME: 'atra_test_bot',
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/apply-migrations.ts'],
      testTimeout: 20_000,
      hookTimeout: 20_000,
    },
  };
});
