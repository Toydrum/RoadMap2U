import { ReplaySubject } from 'rxjs';

const activation = new ReplaySubject<void>(1);
let active = false;

/** Emits only after a product route has completed its local-first startup. */
export const productActivation$ = activation.asObservable();

/** One-way latch used by the deferred service-worker registration strategy. */
export function markProductActive(): void {
  if (active) return;
  active = true;
  activation.next();
}
