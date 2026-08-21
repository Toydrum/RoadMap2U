import { AuthProvider } from './auth-provider';
import { AuthError, AuthErrorCode, AuthNext, AuthSession } from './auth-types';
import { APP_CONFIG } from '../config';

/**
 * The real Cognito adapter — dormant while APP_CONFIG.backend is 'mock'.
 *
 * THE ONLY FILE in the app allowed to mention aws-amplify, and only through
 * dynamic import() so esbuild splits it into a lazy chunk: the initial bundle
 * never pays for it, and boot never loads it (hydration reads a meta key).
 * The chunk loads on the first real auth/API call.
 *
 * ── User-pool creation checklist (the separate backend stack implements this;
 *    the client below already assumes it) ──────────────────────────────────
 *   · Sign-in by USERNAME; email is an optional, verifiable attribute
 *     (guardian-created minors have none — their guardian is recovery).
 *   · App client WITHOUT a client secret; ALLOW_USER_SRP_AUTH enabled.
 *     No Hosted UI and no OAuth flows; the custom account UI needs no redirect
 *     callback or hosting-path fallback.
 *   · Verification and recovery by CODE, never emailed links.
 *   · Password policy = PASSWORD_POLICY (auth-types.ts) — align the pool to
 *     the const, not the other way around.
 *   · Custom attribute custom:accountType ('adult' | 'minor'), written by the
 *     backend only (PostConfirmation trigger / AdminCreateUser) — the client
 *     never sends it; it is defense-in-depth, GET /me is the truth.
 *   · Minors are born via AdminCreateUser (MessageAction SUPPRESS, temp
 *     password) → first sign-in lands in NEW_PASSWORD_REQUIRED below.
 */

/** Cognito exception name → our error vocabulary (unit-tested in isolation). */
export const COGNITO_ERROR_CODES: Readonly<Record<string, AuthErrorCode>> = Object.freeze({
  NotAuthorizedException: 'wrongCredentials',
  UserNotFoundException: 'userNotFound',
  UsernameExistsException: 'userExists',
  AliasExistsException: 'userExists',
  CodeMismatchException: 'codeMismatch',
  ExpiredCodeException: 'codeExpired',
  CodeExpiredException: 'codeExpired',
  InvalidPasswordException: 'passwordPolicy',
  LimitExceededException: 'tooManyAttempts',
  TooManyRequestsException: 'tooManyAttempts',
  TooManyFailedAttemptsException: 'tooManyAttempts',
  NetworkError: 'network',
});

export function mapCognitoError(error: unknown): AuthError {
  if (error instanceof AuthError) return error;
  const name = (error as { name?: string })?.name ?? '';
  if (error instanceof TypeError) return new AuthError('network', 'fetch failed');
  const code = COGNITO_ERROR_CODES[name];
  // NotAuthorized with a clock-skew message deserves the device-clock hint.
  const message = (error as { message?: string })?.message ?? name;
  return new AuthError(code ?? 'unknown', message);
}

type AmplifyAuth = typeof import('aws-amplify/auth');

interface IdTokenLike {
  toString(): string;
  payload: Record<string, unknown>;
}

export class CognitoAuthProvider implements AuthProvider {
  private amplifyAuth?: Promise<AmplifyAuth>;

  /** Memoized lazy load + configure; a failed load retries on the next call. */
  private lib(): Promise<AmplifyAuth> {
    if (!this.amplifyAuth) {
      this.amplifyAuth = (async () => {
        const [{ Amplify }, auth] = await Promise.all([
          import('aws-amplify'),
          import('aws-amplify/auth'),
        ]);
        Amplify.configure({
          Auth: {
            Cognito: {
              userPoolId: APP_CONFIG.aws.userPoolId,
              userPoolClientId: APP_CONFIG.aws.userPoolClientId,
              loginWith: { username: true },
            },
          },
        });
        return auth;
      })().catch((error) => {
        this.amplifyAuth = undefined;
        throw new AuthError('network', `auth library unavailable: ${error}`);
      });
    }
    return this.amplifyAuth;
  }

  async signIn(username: string, password: string): Promise<AuthNext> {
    const auth = await this.lib();
    try {
      const result = await auth.signIn({ username: username.trim(), password });
      return await this.nextFromSignIn(auth, result.nextStep.signInStep, username.trim());
    } catch (error) {
      // Signing in on a not-yet-confirmed account is a step, not a failure.
      if ((error as { name?: string })?.name === 'UserNotConfirmedException') {
        return { kind: 'confirmSignUp', username: username.trim(), deliveryHint: null };
      }
      throw mapCognitoError(error);
    }
  }

  async signUp(input: {
    username: string;
    password: string;
    email: string;
    displayName: string;
  }): Promise<AuthNext> {
    const auth = await this.lib();
    try {
      // displayName severed from signup (0.0.108): Cognito rejects EMPTY
      // attribute values, so `name` travels only when there is one.
      const name = input.displayName.trim();
      const result = await auth.signUp({
        username: input.username.trim(),
        password: input.password,
        options: {
          userAttributes: {
            email: input.email.trim(),
            ...(name ? { name } : {}),
          },
        },
      });
      if (result.nextStep.signUpStep === 'CONFIRM_SIGN_UP') {
        return {
          kind: 'confirmSignUp',
          username: input.username.trim(),
          deliveryHint: result.nextStep.codeDeliveryDetails?.destination ?? null,
        };
      }
      // Auto-confirmed pools go straight to a fresh sign-in.
      return this.signIn(input.username, input.password);
    } catch (error) {
      throw mapCognitoError(error);
    }
  }

  async confirmSignUp(username: string, code: string): Promise<void> {
    const auth = await this.lib();
    try {
      await auth.confirmSignUp({ username: username.trim(), confirmationCode: code.trim() });
    } catch (error) {
      throw mapCognitoError(error);
    }
  }

  async resendCode(username: string): Promise<void> {
    const auth = await this.lib();
    try {
      await auth.resendSignUpCode({ username: username.trim() });
    } catch (error) {
      throw mapCognitoError(error);
    }
  }

  async completeNewPassword(newPassword: string): Promise<AuthNext> {
    const auth = await this.lib();
    try {
      const result = await auth.confirmSignIn({ challengeResponse: newPassword });
      return await this.nextFromSignIn(auth, result.nextStep.signInStep, null);
    } catch (error) {
      throw mapCognitoError(error);
    }
  }

  async forgotPassword(username: string): Promise<{ deliveryHint: string | null }> {
    const auth = await this.lib();
    try {
      const result = await auth.resetPassword({ username: username.trim() });
      return {
        deliveryHint:
          result.nextStep.resetPasswordStep === 'CONFIRM_RESET_PASSWORD_WITH_CODE'
            ? (result.nextStep.codeDeliveryDetails?.destination ?? null)
            : null,
      };
    } catch (error) {
      throw mapCognitoError(error);
    }
  }

  async confirmForgotPassword(username: string, code: string, newPassword: string): Promise<void> {
    const auth = await this.lib();
    try {
      await auth.confirmResetPassword({
        username: username.trim(),
        confirmationCode: code.trim(),
        newPassword,
      });
    } catch (error) {
      throw mapCognitoError(error);
    }
  }

  async signOut(): Promise<void> {
    const auth = await this.lib();
    try {
      await auth.signOut();
    } catch (error) {
      throw mapCognitoError(error);
    }
  }

  async currentSession(): Promise<AuthSession | null> {
    const auth = await this.lib();
    try {
      const session = await auth.fetchAuthSession();
      const idToken = session.tokens?.idToken as IdTokenLike | undefined;
      return idToken ? this.sessionFromIdToken(idToken) : null;
    } catch (error) {
      if ((error as { name?: string })?.name === 'UserUnAuthenticatedException') return null;
      throw mapCognitoError(error);
    }
  }

  async idToken(opts?: { forceRefresh?: boolean }): Promise<string | null> {
    try {
      const auth = await this.lib();
      const session = await auth.fetchAuthSession(
        opts?.forceRefresh ? { forceRefresh: true } : undefined,
      );
      return session.tokens?.idToken?.toString() ?? null;
    } catch {
      // The API layer turns a missing token into UNAUTHENTICATED/offline.
      return null;
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async nextFromSignIn(
    auth: AmplifyAuth,
    step: string,
    username: string | null,
  ): Promise<AuthNext> {
    switch (step) {
      case 'DONE': {
        const session = await this.currentSession();
        if (!session) throw new AuthError('unknown', 'signed in but no session');
        return { kind: 'done', session };
      }
      case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
        return { kind: 'newPasswordRequired' };
      case 'CONFIRM_SIGN_UP':
        return { kind: 'confirmSignUp', username: username ?? '', deliveryHint: null };
      default:
        // MFA and friends are disabled by pool design — reaching here means
        // the pool drifted from the checklist above.
        throw new AuthError('unknown', `unsupported sign-in step: ${step}`);
    }
  }

  private sessionFromIdToken(idToken: IdTokenLike): AuthSession {
    const claims = idToken.payload;
    const str = (key: string): string | null =>
      typeof claims[key] === 'string' ? (claims[key] as string) : null;
    return {
      user: {
        userId: str('sub') ?? '',
        username: str('cognito:username') ?? '',
        email: str('email'),
        displayName: str('name'),
        accountType: str('custom:accountType') === 'minor' ? 'minor' : 'adult',
      },
      issuedAt: Date.now(),
    };
  }
}

/** Generic lazy entrypoint keeps provider-specific symbols out of main.js. */
export function createAuthProvider(): AuthProvider {
  return new CognitoAuthProvider();
}
