import { InjectionToken } from '@angular/core';
import { DEPLOY_STAGE } from '../config';
import { isBillingSimulation, type BillingSimulation } from './contracts';
export const SIMULATION_ONLINE_MS = 15_000;

/** Fixed build configuration, not a URL, storage or user-selectable override. */
export const BILLING_SIMULATION_STAGE = new InjectionToken<string>('BILLING_SIMULATION_STAGE', {
  providedIn: 'root',
  factory: () => DEPLOY_STAGE,
});
export function currentBillingSimulation(
  value: unknown,
  stage: string,
  now: number,
): value is BillingSimulation {
  return (
    isBillingSimulation(value) &&
    value.stage === stage &&
    value.observedAt <= now &&
    now - value.observedAt < SIMULATION_ONLINE_MS &&
    (value.mode === 'unavailable' || value.evidenceValidUntil! > now)
  );
}
