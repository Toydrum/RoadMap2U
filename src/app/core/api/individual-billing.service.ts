import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { AccessService } from '../access/access.service';
import { API_CLIENT } from './api-client';
import { BILLING_SIMULATION_STAGE, currentBillingSimulation } from './billing-simulation';
import {
  onAccountClosureQuiesce,
  captureAccountClosureReadEpoch,
  canPublishAccountClosureRead,
} from '../db/account-closure-fence';
import {
  ApiError,
  isIndividualBillingSummary,
  isIndividualBillingCommandResult,
  type ApiErrorCode,
  type IndividualBillingSummary,
  type IndividualCheckoutRequest,
  type IndividualBillingCommandResult,
  type IndividualPortalRequest,
} from './contracts';

export const BILLING_CONFIRMATION_MS = 60_000;
export const BILLING_POLL_MS = 5_000;
export const BILLING_RUNTIME = new InjectionToken<{
  now(): number;
  schedule(callback: () => void, ms: number): () => void;
}>('BILLING_RUNTIME', {
  providedIn: 'root',
  factory: () => ({
    now: Date.now,
    schedule(callback, ms) {
      const id = setTimeout(callback, ms);
      return () => clearTimeout(id);
    },
  }),
});
export const BILLING_NAVIGATION = new InjectionToken<(url: string) => void>('BILLING_NAVIGATION', {
  providedIn: 'root',
  factory: () => (url) => location.assign(url),
});

/** Financial presentation only. Access remains the separate validated access seam. */
@Injectable({ providedIn: 'root' })
export class IndividualBillingService {
  private readonly api = inject(API_CLIENT);
  private readonly auth = inject(AuthService);
  private readonly access = inject(AccessService);
  private readonly runtime = inject(BILLING_RUNTIME);
  private readonly stage = inject(BILLING_SIMULATION_STAGE);
  private readonly navigate = inject(BILLING_NAVIGATION);
  private readonly summaryState = signal<IndividualBillingSummary | null>(null);
  private readonly errorState = signal<ApiErrorCode | null>(null);
  private readonly busyState = signal(false);
  private readonly loadingState = signal(false);
  private readonly confirmationState = signal<'idle' | 'checking' | 'waiting'>('idle');
  private readonly quiesced = signal(
    !canPublishAccountClosureRead(captureAccountClosureReadEpoch()),
  );
  private actor = this.auth.user()?.userId ?? null;
  private generation = 0;
  private pollGeneration = 0;
  private stopPoll: (() => void) | null = null;
  private stopDeadline: (() => void) | null = null;
  private refreshRequest: Promise<void> | null = null;
  private checkoutRequest: IndividualCheckoutRequest | null = null;
  private checkoutFlight: IndividualCheckoutRequest | null = null;
  private terminalCheckoutRevision: number | null = null;

  readonly summary = this.summaryState.asReadonly();
  readonly error = this.errorState.asReadonly();
  readonly busy = this.busyState.asReadonly();
  readonly loading = this.loadingState.asReadonly();
  readonly confirmation = this.confirmationState.asReadonly();
  readonly pending = computed(
    () =>
      this.confirmation() !== 'idle' ||
      this.summary()?.processing === 'pending' ||
      this.summary()?.state === 'checkout_pending',
  );
  readonly canCheckout = computed(() => {
    const summary = this.summary();
    return Boolean(
      summary?.canCheckout &&
      summary.processing === 'idle' &&
      (summary.state === 'none' || summary.state === 'expired') &&
      !this.pending() &&
      !this.busy() &&
      !this.loading() &&
      !this.error() &&
      !this.quiesced(),
    );
  });

  constructor() {
    const stopClosure = onAccountClosureQuiesce(() => {
      this.quiesced.set(true);
      this.generation++;
      this.cancelConfirmation();
      this.summaryState.set(null);
      this.errorState.set(null);
      this.checkoutRequest = null;
      this.checkoutFlight = null;
      this.terminalCheckoutRevision = null;
      this.refreshRequest = null;
      this.busyState.set(false);
      this.loadingState.set(false);
    });
    effect(() => {
      const actor = this.auth.user()?.userId ?? null;
      if (actor === this.actor) return;
      this.actor = actor;
      this.generation++;
      this.cancelConfirmation();
      this.summaryState.set(null);
      this.errorState.set(null);
      this.busyState.set(false);
      this.loadingState.set(false);
      this.checkoutRequest = null;
      this.checkoutFlight = null;
      this.terminalCheckoutRevision = null;
      this.refreshRequest = null;
    });
    inject(DestroyRef).onDestroy(() => {
      stopClosure();
      this.generation++;
      this.cancelConfirmation();
    });
  }

  refresh(): Promise<void> {
    if (!this.auth.user() || this.quiesced()) return Promise.resolve();
    if (this.refreshRequest) return this.refreshRequest;
    const actor = this.auth.user()!.userId;
    const generation = this.generation;
    const checkoutFlightAtRead = this.checkoutFlight;
    this.loadingState.set(true);
    const request = Promise.allSettled([
      this.bounded(this.api.getIndividualBillingSummary()).then((value) => {
        if (!this.current(actor, generation)) return;
        if (!isIndividualBillingSummary(value)) throw new ApiError('unknown');
        if (
          value.simulation &&
          !currentBillingSimulation(value.simulation, this.stage, this.runtime.now())
        )
          throw new ApiError('unknown');
        if (value.revision < (this.summary()?.revision ?? 0)) return;
        // A terminal reservation is a server fact. A read that began while its POST
        // was still in flight cannot retire that request, even if it finishes later.
        const terminal =
          !checkoutFlightAtRead && !this.checkoutFlight && this.checkoutTerminated(value);
        this.terminalCheckoutRevision = terminal ? value.revision : null;
        if (terminal) this.checkoutRequest = null;
        this.summaryState.set(structuredClone(value));
        this.errorState.set(null);
      }),
      this.bounded(this.access.refresh()),
    ])
      .then((results) => {
        if (!this.current(actor, generation)) return;
        const financial = results[0];
        if (financial.status === 'rejected') {
          if (this.summary()?.simulation) this.summaryState.set(null);
          this.errorState.set(
            financial.reason instanceof ApiError ? financial.reason.code : 'unknown',
          );
        }
      })
      .finally(() => {
        if (this.refreshRequest === request) this.refreshRequest = null;
        if (this.current(actor, generation)) this.loadingState.set(false);
      });
    this.refreshRequest = request;
    return request;
  }

  /** A return parameter only starts reads. It never grants access or marks payment paid. */
  async confirm(kind: 'checkout' | 'portal' = 'checkout'): Promise<void> {
    if (!this.auth.user() || this.quiesced()) return;
    this.cancelConfirmation();
    this.confirmationState.set('checking');
    const poll = ++this.pollGeneration;
    const deadline = this.runtime.now() + BILLING_CONFIRMATION_MS;
    this.stopDeadline = this.runtime.schedule(() => {
      if (poll !== this.pollGeneration) return;
      this.stopPoll?.();
      this.stopPoll = null;
      this.confirmationState.set('waiting');
    }, BILLING_CONFIRMATION_MS);
    const read = async () => {
      await this.refresh();
      if (poll !== this.pollGeneration || this.confirmation() !== 'checking') return;
      const summary = this.summary();
      const access = this.access.access(),
        simulation = summary?.simulation;
      const sameClock = simulation
        ? access.simulation &&
          simulation.mode === 'ready' &&
          access.simulation.mode === 'ready' &&
          currentBillingSimulation(simulation, this.stage, this.runtime.now()) &&
          currentBillingSimulation(access.simulation, this.stage, this.runtime.now()) &&
          simulation.clockRevision === access.simulation.clockRevision &&
          simulation.frozenAt === access.simulation.frozenAt
        : !access.simulation;
      const paidAccess =
        sameClock &&
        access.activeSources.some(
          (source) =>
            source.kind === 'subscription' &&
            source.scope === 'individual' &&
            source.validUntil !== null &&
            source.validUntil > (simulation?.frozenAt ?? this.runtime.now()),
        );
      const resolved =
        !this.error() &&
        summary?.processing === 'idle' &&
        (kind === 'portal'
          ? summary.state !== 'checkout_pending'
          : summary.state === 'active' || summary.state === 'cancel_at_period_end'
            ? paidAccess
            : summary.state === 'none' || summary.state === 'expired'
              ? this.terminalCheckoutRevision === summary.revision
              : ['past_due', 'closed'].includes(summary.state));
      if (resolved || summary?.processing === 'review') {
        this.cancelConfirmation();
        return;
      }
      if (this.runtime.now() >= deadline) {
        this.confirmationState.set('waiting');
        return;
      }
      this.stopPoll = this.runtime.schedule(
        () => void read(),
        Math.min(BILLING_POLL_MS, deadline - this.runtime.now()),
      );
    };
    await read();
  }

  async checkout(
    input: Omit<IndividualCheckoutRequest, 'commandId' | 'expectedBillingRevision'>,
  ): Promise<void> {
    if (!this.canCheckout()) return;
    const request = this.checkoutRequest ?? {
      ...input,
      commandId: crypto.randomUUID(),
      expectedBillingRevision: this.summary()!.revision,
    };
    // Keep original parameters and command identity if an outcome was uncertain.
    this.checkoutRequest = request;
    this.terminalCheckoutRevision = null;
    await this.command('checkout', request);
  }

  async portal(): Promise<void> {
    if (!this.summary()?.canOpenPortal || this.busy() || this.quiesced()) return;
    await this.command('portal', {
      commandId: crypto.randomUUID(),
      expectedBillingRevision: this.summary()!.revision,
    });
  }

  private async command(
    kind: 'checkout' | 'portal',
    request: IndividualCheckoutRequest | IndividualPortalRequest,
  ): Promise<void> {
    const actor = this.auth.user()?.userId;
    if (!actor || this.busy() || this.quiesced()) return;
    const generation = this.generation;
    this.busyState.set(true);
    this.errorState.set(null);
    try {
      const result = await this.bounded(
        kind === 'checkout'
          ? this.sendCheckout(request as IndividualCheckoutRequest)
          : this.api.createIndividualPortalSession(request),
      );
      if (!this.current(actor, generation)) return;
      this.validateResult(result, kind, request);
      if (result.outcome === 'redirect') this.navigate(result.url);
      else await this.confirm(kind);
    } catch (error) {
      if (!this.current(actor, generation)) return;
      const code = error instanceof ApiError ? error.code : 'unknown';
      this.errorState.set(code);
      if (
        [
          'BILLING_TERMS_OUTDATED',
          'BILLING_BUYER_INELIGIBLE',
          'BILLING_REVISION_CONFLICT',
          'VALIDATION',
          'BILLING_SUBSCRIPTION_EXISTS',
        ].includes(code)
      ) {
        this.checkoutRequest = null;
        await this.refresh();
        this.errorState.set(code);
      } else if (kind === 'checkout') {
        // Unknown transport outcomes stay a read-only confirmation flow.
        await this.confirm();
      }
    } finally {
      if (this.current(actor, generation)) this.busyState.set(false);
    }
  }

  private checkoutTerminated(summary: IndividualBillingSummary): boolean {
    if (summary.processing !== 'idle' || !['none', 'expired'].includes(summary.state)) return false;
    if (this.checkoutRequest)
      return summary.canCheckout && summary.revision > this.checkoutRequest.expectedBillingRevision;
    return summary.state === 'expired' || (summary.canCheckout && summary.revision > 0);
  }

  private async sendCheckout(
    request: IndividualCheckoutRequest,
  ): Promise<IndividualBillingCommandResult> {
    this.checkoutFlight = request;
    try {
      return await this.api.createIndividualCheckout(request);
    } finally {
      if (this.checkoutFlight === request) this.checkoutFlight = null;
    }
  }

  private validateResult(
    value: unknown,
    kind: 'checkout' | 'portal',
    request: IndividualPortalRequest,
  ): asserts value is IndividualBillingCommandResult {
    if (
      !isIndividualBillingCommandResult(value) ||
      value.commandId !== request.commandId ||
      value.billingRevision < request.expectedBillingRevision
    )
      throw new ApiError('unknown');
    if (
      value.outcome === 'redirect' &&
      (value.expiresAt <= this.runtime.now() ||
        new URL(value.url).hostname !==
          (kind === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com'))
    )
      throw new ApiError('unknown');
  }

  private bounded<T>(request: Promise<T>): Promise<T> {
    let cancel: () => void = () => undefined;
    const deadline = new Promise<T>((_, reject) => {
      cancel = this.runtime.schedule(() => reject(new ApiError('offline')), 15_000);
    });
    return Promise.race([request, deadline]).finally(() => cancel());
  }
  private current(actor: string, generation: number): boolean {
    return this.generation === generation && this.auth.user()?.userId === actor;
  }
  private cancelConfirmation(): void {
    this.pollGeneration++;
    this.stopPoll?.();
    this.stopDeadline?.();
    this.stopPoll = null;
    this.stopDeadline = null;
    this.confirmationState.set('idle');
  }
}
