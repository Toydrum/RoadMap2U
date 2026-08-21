import { InjectionToken } from '@angular/core';
import { AuthNext, AuthSession } from './auth-types';

/**
 * The identity seam. Two implementations, chosen once at boot by
 * APP_CONFIG.backend: MockAuthProvider (on-device simulated cloud, offline,
 * deterministic) and CognitoAuthProvider (lazy aws-amplify). The AuthService
 * facade is the only caller — components talk to signals, never to this.
 *
 * Error contract: flow methods throw AuthError; `currentSession`/`idToken`
 * NEVER throw for "no session" — they return null (fail-open boot doctrine).
 */
export interface AuthProvider {
  signIn(username: string, password: string): Promise<AuthNext>;
  signUp(input: {
    username: string;
    password: string;
    email: string;
    displayName: string;
  }): Promise<AuthNext>;
  confirmSignUp(username: string, code: string): Promise<void>;
  resendCode(username: string): Promise<void>;
  /** Continues the pending newPasswordRequired challenge from signIn. */
  completeNewPassword(newPassword: string): Promise<AuthNext>;
  forgotPassword(username: string): Promise<{ deliveryHint: string | null }>;
  confirmForgotPassword(username: string, code: string, newPassword: string): Promise<void>;
  signOut(): Promise<void>;
  /** Cached or refreshed session; null when signed out. */
  currentSession(): Promise<AuthSession | null>;
  /** Bearer token for the ApiClient; forceRefresh drives the 401-retry path. */
  idToken(opts?: { forceRefresh?: boolean }): Promise<string | null>;
}

export const AUTH_PROVIDER = new InjectionToken<AuthProvider>('AUTH_PROVIDER');
