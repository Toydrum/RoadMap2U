/**
 * Process-local half of terminal account cleanup's write barrier.
 *
 * The broadcast asks sibling tabs to stop producing user writes before the
 * deleting tab replaces IndexedDB. Each tab also registers every write before
 * its first await, so the deleting tab can drain work which already crossed
 * the preflight check. BroadcastChannel has no peer enumeration/ack protocol;
 * the remaining delivery race is documented at the cleanup call site and is
 * handled conservatively by keeping old tabs fenced once they receive it.
 */

const CHANNEL_NAME = 'roadmap2u-account-closure';
const QUIESCE_MESSAGE = Object.freeze({ type: 'quiesce' as const });
type QuiesceListener = () => void;
type PendingWrite = Promise<unknown>;

let quiesced = false;
let readEpoch = 0;
const listeners = new Set<QuiesceListener>();
const pendingWrites = new Set<PendingWrite>();

const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;

export class LocalWritesQuiescedError extends Error {
  constructor() {
    super('Local account writes are quiesced for terminal account closure');
    this.name = 'LocalWritesQuiescedError';
  }
}

function notifyQuiesce(): void {
  quiesced = true;
  readEpoch += 1;
  for (const listener of listeners) listener();
}

channel?.addEventListener('message', (event) => {
  const value = event.data as { type?: unknown } | null;
  if (value?.type === QUIESCE_MESSAGE.type) notifyQuiesce();
});

export function onAccountClosureQuiesce(listener: QuiesceListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Sets the local barrier synchronously, then tells sibling tabs. */
export function quiesceAccountClosureWrites(): void {
  notifyQuiesce();
  channel?.postMessage(QUIESCE_MESSAGE);
}

/** Only the tab which completed cleanup may write again before navigation. */
export function resumeAccountClosureWritesLocally(): void {
  quiesced = false;
}

/**
 * Async repository reads are intentionally not IndexedDB-write fenced: the
 * terminal export still needs readonly access. They do, however, need a
 * publication generation so a pre-fence load cannot refill signals after
 * cleanup reset them.
 */
export function captureAccountClosureReadEpoch(): number {
  return readEpoch;
}

export function canPublishAccountClosureRead(epoch: number): boolean {
  return !quiesced && epoch === readEpoch;
}

export function assertAccountClosureWriteAllowed(store: string, value: unknown): void {
  if (!quiesced) return;
  throw new LocalWritesQuiescedError();
}

/**
 * Registers a write before it can await opening IndexedDB. This closes the
 * check/open gap: a terminal cleanup sees and drains every local operation
 * which passed the barrier before quiesce.
 */
export async function runAccountClosureGuardedWrite<T>(
  entries: readonly { store: string; value: unknown }[],
  operation: () => Promise<T>,
): Promise<T> {
  for (const entry of entries) assertAccountClosureWriteAllowed(entry.store, entry.value);
  const pending = operation();
  pendingWrites.add(pending);
  try {
    const result = await pending;
    // The storage operation may have crossed the barrier before quiesce and
    // is therefore allowed to finish so terminal cleanup can drain it. Its
    // caller must not interpret that completion as permission to republish
    // the just-cleared row into an in-memory repository, though.
    for (const entry of entries) assertAccountClosureWriteAllowed(entry.store, entry.value);
    return result;
  } finally {
    pendingWrites.delete(pending);
  }
}

export async function drainAccountClosureWrites(): Promise<void> {
  while (pendingWrites.size) await Promise.allSettled([...pendingWrites]);
}
