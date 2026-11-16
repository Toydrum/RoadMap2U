import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { DEPLOY_STAGE } from '../config';
import { API_CLIENT } from './api-client';
import { ApiError, type StepSuggestionsRequest } from './contracts';

@Injectable({ providedIn: 'root' })
export class StepSuggestionsService {
  private readonly auth = inject(AuthService);
  private readonly api = inject(API_CLIENT);
  private readonly authorizedSession = signal<string | null>(null);
  private checkedSession: string | null = null;
  private lastResult: { session: string; key: string; titles: readonly string[] } | null = null;
  private generation = 0;

  readonly session = computed(() => {
    if (String(DEPLOY_STAGE) !== 'dev' || this.auth.status() !== 'signedIn' || this.auth.sessionStale()) {
      return null;
    }
    const user = this.auth.user();
    const deviceSession = this.auth.deviceSession();
    return user?.accountType === 'adult' && deviceSession ? `${user.userId}/${deviceSession}` : null;
  });

  readonly available = computed(() => {
    const session = this.session();
    return session !== null && this.authorizedSession() === session;
  });

  constructor() {
    effect(() => {
      const session = this.session();
      if (this.checkedSession !== session) this.checkedSession = null;
      if (this.lastResult?.session !== session) this.lastResult = null;
      if (this.authorizedSession() !== session) this.authorizedSession.set(null);
    });
  }

  async checkEligibility(): Promise<void> {
    const session = this.session();
    if (!session || session === this.checkedSession || !navigator.onLine) return;
    this.checkedSession = session;
    const userId = this.auth.user()?.userId;
    try {
      const me = await this.api.getMe();
      if (this.session() === session && me.profile.userId === userId && me.stepSuggestionsPilot === true) {
        this.authorizedSession.set(session);
      }
    } catch {
      // The manual flow remains available when the initial eligibility read fails.
    }
  }

  cached(branchId: string, context: StepSuggestionsRequest): readonly string[] | null {
    const result = this.lastResult;
    return this.available() && result?.session === this.session() &&
      result.key === JSON.stringify([branchId, context]) ? result.titles : null;
  }

  async generate(branchId: string, context: StepSuggestionsRequest): Promise<readonly string[]> {
    const session = this.session();
    if (!session || !this.available()) throw new ApiError('FORBIDDEN');
    const generation = ++this.generation;
    const { suggestions } = await this.api.suggestSteps(context);
    if (this.session() !== session) throw new ApiError('UNAUTHENTICATED');
    if (!Array.isArray(suggestions) || suggestions.length !== (context.maxSuggestions ?? 3) || suggestions.some((title) =>
      typeof title !== 'string' || !title.trim() || title.length > 80 || /[\r\n]/u.test(title),
    )) {
      throw new ApiError('STEP_SUGGESTIONS_UNAVAILABLE');
    }
    if (this.generation === generation) {
      this.lastResult = { session, key: JSON.stringify([branchId, context]), titles: suggestions };
    }
    return suggestions;
  }
}
