import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import type { AppEnv } from './context.js';
import type { Services } from '../core/services.js';
import { csrfGuard, hostGuard, requestContext, securityHeaders } from './middleware.js';
import { systemRoutes } from './routes/system.js';
import { authRoutes } from './routes/auth.js';
import { setupRoutes } from './routes/setup.js';
import { walletRoutes } from './routes/wallet.js';
import { activityRoutes, controlRoutes, riskRoutes } from './routes/control.js';
import { overviewRoutes } from './routes/overview.js';
import { marketRoutes, watchlistRoutes } from './routes/market.js';
import { childLogger } from '../logging/logger.js';
import { AppError, ErrorCode } from '../util/errors.js';
import { toProblem } from './respond.js';

/**
 * The local HTTP server.
 *
 * Binds to loopback by default. It serves the dashboard's built assets when a
 * static directory is configured, so a single container gives the operator one
 * URL, and exposes the API under /api/v1.
 *
 * There is no generic "call this contract" endpoint anywhere in this surface.
 * Every write is a named operation with its own schema and its own checks.
 */
export function createApp(services: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // onError rather than a try/catch middleware: Hono routes errors thrown
  // anywhere in the tree, including inside mounted sub-apps, to this handler.
  app.onError((error, c) => {
    const problem = toProblem(error, c.get('requestId') ?? 'unknown');
    return c.json(problem, problem.status as 400, {
      'content-type': 'application/problem+json',
      'x-request-id': problem.requestId,
      ...(problem.retryAfterSec === undefined
        ? {}
        : { 'retry-after': String(problem.retryAfterSec) }),
    });
  });

  app.use('*', requestContext());
  app.use('*', securityHeaders());
  app.use('*', async (c, next) => {
    c.set('services', services);
    c.set('mode', services.state.getMode());
    await next();
  });
  app.use('*', hostGuard(services.config.hostAllowlist));
  app.use('*', csrfGuard(services.config.corsOrigins));

  // The largest legitimate body is a full risk policy, a few kilobytes. Anything
  // approaching a megabyte is not a dashboard request, and buffering it before
  // authentication would let an anonymous caller consume memory at will.
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: 256 * 1024,
      onError: () => {
        throw new AppError(ErrorCode.SCHEMA_INVALID, 'Request body is too large', {
          status: 413,
        });
      },
    }),
  );

  app.route('/', systemRoutes());
  app.route('/api/v1/auth', authRoutes());
  app.route('/api/v1/setup', setupRoutes());
  app.route('/api/v1/wallet', walletRoutes());
  app.route('/api/v1/control', controlRoutes());
  app.route('/api/v1/risk', riskRoutes());
  app.route('/api/v1/activity', activityRoutes());
  app.route('/api/v1/market', marketRoutes());
  app.route('/api/v1/watchlist', watchlistRoutes());
  app.route('/api/v1', overviewRoutes());

  app.all('/api/*', (c) => {
    throw new AppError(ErrorCode.NOT_FOUND, `No such endpoint: ${c.req.method} ${c.req.path}`);
  });

  mountDashboard(app, services);

  return app;
}

/**
 * Serve the built dashboard, if one is present.
 *
 * The frontend is built separately and its output directory is passed in, so
 * the backend has no build-time dependency on it: a runtime with no dashboard
 * still serves its API and its health endpoint.
 */
function mountDashboard(app: Hono<AppEnv>, services: Services): void {
  const log = childLogger('http');
  const dir = services.config.staticDir;

  if (!dir || !existsSync(dir)) {
    app.get('/', (c) =>
      c.json({
        name: 'ATRA runtime',
        api: '/api/v1',
        health: '/health',
        dashboard: 'not bundled with this runtime',
      }),
    );
    return;
  }

  // serve-static resolves against the working directory, so pass it a relative
  // root rather than an absolute one.
  const root = relative(process.cwd(), dir).split('\\').join('/') || '.';
  log.info({ root }, 'serving dashboard assets');

  app.use('/assets/*', serveStatic({ root }));
  app.use('/favicon.ico', serveStatic({ root }));
  // The dashboard is a single-page app: anything that is not an API route falls
  // back to its entry document so client-side routing works on a hard refresh.
  app.get('*', serveStatic({ root, path: 'index.html' }));
}

export interface StartedServer {
  server: ReturnType<typeof serve>;
  port: number;
  close: () => Promise<void>;
}

export function startServer(services: Services): Promise<StartedServer> {
  const log = childLogger('http');
  const app = createApp(services);

  return new Promise((resolve, reject) => {
    try {
      const server = serve(
        { fetch: app.fetch, hostname: services.config.host, port: services.config.port },
        (info) => {
          log.info({ host: services.config.host, port: info.port }, 'ATRA runtime listening');
          resolve({
            server,
            port: info.port,
            close: () =>
              new Promise<void>((done, fail) => {
                server.close((error) => (error ? fail(error) : done()));
              }),
          });
        },
      );

      server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          // Failing loudly beats silently picking another port: the dashboard,
          // the docs and the CI health check all assume a fixed address.
          reject(
            new AppError(
              ErrorCode.INTERNAL,
              `Port ${services.config.port} is already in use. Stop the other process or set ATRA_PORT.`,
              { cause: error },
            ),
          );
          return;
        }
        reject(error);
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
