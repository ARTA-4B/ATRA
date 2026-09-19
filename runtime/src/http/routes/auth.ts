import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppEnv } from '../context.js';
import { envelope, invalid } from '../respond.js';
import { AppError, ErrorCode } from '../../util/errors.js';
import { SESSION_COOKIE, REAUTH_HEADER, loopbackOnly, requireSession } from '../middleware.js';
import type { ReauthPurpose } from '../../core/auth.js';

/**
 * Authentication routes.
 *
 * The password does double duty: it authenticates the dashboard session and
 * derives the key that unlocks the wallet vault. That is deliberate — an
 * operator who is signed in can see balances and history, and the vault is
 * unlocked for as long as they are working, but anything that can move or
 * reveal funds demands the password again through `/auth/reauth`.
 */

const passwordSchema = z.object({ password: z.string().min(1).max(512) });

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(12).max(512),
});

const reauthSchema = z.object({
  password: z.string().min(1).max(512),
  purpose: z.enum([
    'wallet.export',
    'wallet.withdraw',
    'mode.live',
    'auth.password',
    'settings.reset',
    'settings.secret',
  ]),
});

export function authRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /** Current session, if any. Used by the dashboard on load. */
  app.get('/session', (c) => {
    const services = c.get('services');
    const session = services.auth.resolveSession(getCookie(c, SESSION_COOKIE));

    return c.json(
      envelope(c, {
        authenticated: session !== undefined,
        expiresAt: session?.expiresAt ?? null,
        vaultUnlocked: services.vault.isUnlocked,
        setupRequired: !services.auth.isConfigured,
      }),
    );
  });

  /**
   * First-run: set the password and create the vault in one step.
   *
   * Loopback only. The vault is created with the same password, and the
   * response carries a session so the wizard can continue without a second
   * prompt.
   */
  app.post('/setup', loopbackOnly(), async (c) => {
    const services = c.get('services');
    const body = await parse(c, passwordSchema);

    if (services.auth.isConfigured) {
      throw new AppError(ErrorCode.ALREADY_INITIALIZED, 'A password has already been set');
    }

    await services.auth.setPassword(body.password);
    await services.vault.initialize(body.password);

    const session = services.auth.createSession();
    writeSessionCookie(c, session.token, session.expiresAt);

    return c.json(
      envelope(c, { expiresAt: session.expiresAt, vaultUnlocked: services.vault.isUnlocked }),
      201,
    );
  });

  /** Sign in and unlock the vault. */
  app.post('/login', async (c) => {
    const services = c.get('services');
    const body = await parse(c, passwordSchema);

    const session = await services.auth.login(body.password);

    // Unlocking is best-effort: an install that has a password but no vault yet
    // (setup interrupted between the two writes) should still be able to sign
    // in and finish the wizard.
    if (services.vault.isInitialized) {
      await services.vault.unlock(body.password);
    }

    writeSessionCookie(c, session.token, session.expiresAt);
    return c.json(
      envelope(c, { expiresAt: session.expiresAt, vaultUnlocked: services.vault.isUnlocked }),
    );
  });

  app.post('/logout', requireSession(), (c) => {
    const services = c.get('services');
    const session = c.get('session')!;

    services.auth.revokeSession(session.id);
    services.vault.lock();
    deleteCookie(c, SESSION_COOKIE, { path: '/' });

    return c.json(envelope(c, { signedOut: true }));
  });

  /**
   * Issue a single-use token for a sensitive action.
   *
   * The token is bound to both the session and the purpose, so one obtained for
   * a withdrawal cannot be replayed against a key export.
   */
  app.post('/reauth', requireSession(), async (c) => {
    const services = c.get('services');
    const session = c.get('session')!;
    const body = await parse(c, reauthSchema);

    const token = await services.auth.issueReauthToken(
      session.id,
      body.purpose as ReauthPurpose,
      body.password,
    );

    // Unlocking here means a sensitive action does not fail on an auto-locked
    // vault immediately after the operator proved they know the password.
    if (services.vault.isInitialized && !services.vault.isUnlocked) {
      await services.vault.unlock(body.password);
    }

    return c.json(envelope(c, { token: token.token, expiresAt: token.expiresAt, header: REAUTH_HEADER }));
  });

  /** Change the password and rewrap the vault in the same operation. */
  app.post('/password', requireSession(), async (c) => {
    const services = c.get('services');
    const session = c.get('session')!;
    const body = await parse(c, changePasswordSchema);

    services.auth.consumeReauthToken(c.req.header(REAUTH_HEADER), 'auth.password', session.id);

    // Rewrap first: if this fails, the login password is unchanged and the
    // vault is still openable. The reverse order could leave an install whose
    // password no longer opens its own wallet.
    if (services.vault.isInitialized) {
      await services.vault.changePassword(body.currentPassword, body.newPassword);
    }
    await services.auth.changePassword(body.currentPassword, body.newPassword);

    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json(envelope(c, { changed: true, signedOut: true }));
  });

  return app;
}

function writeSessionCookie(c: Parameters<typeof setCookie>[0], token: string, expiresAt: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Strict',
    expires: new Date(expiresAt),
    // `secure` is intentionally off: the dashboard is served over http on
    // loopback, and a Secure cookie would simply not be stored.
  });
}

/** Parse a JSON body against a schema, reporting every issue at once. */
export async function parse<T extends z.ZodType>(
  c: { req: { json: () => Promise<unknown> } },
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw invalid('Request body must be JSON', [{ path: '', message: 'malformed JSON' }]);
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    throw invalid(
      'Request body is not valid',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }

  return result.data;
}
