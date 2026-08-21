import { StoreName } from './idb';

/**
 * Cross-tab record refresh. Every mutation posts {store, ids}; other tabs
 * re-read those records and apply them if the incoming rev is newer.
 * Cloud sync rides the same two rails: outbound via onLocalWrite (below),
 * inbound via RecordsRepo.applyExternal — see core/api/contracts.ts.
 */

export interface DbChangeMessage {
  store: StoreName;
  ids: string[];
  /** Stable id for the logical write that produced these rows. Old tabs may
   *  omit it; broadcastChange fills one before notifying this tab or peers. */
  mutationGroupId?: string;
  /** «El reset» (0.0.115): an import-replace restored OLDER revs on disk —
   *  sibling tabs must reload the store wholesale, SKIPPING the LWW guard
   *  (which would correctly-but-wrongly reject the restored copies and then
   *  re-persist exactly what the user reverted). */
  reset?: boolean;
}

/** One CSPRNG id per logical operation. Callers performing an atomic
 * cross-store write mint it ONCE and pass it to every broadcast; the default
 * below mints once per ordinary write invocation. Never derive this id from
 * owner identity or record content. */
export function createMutationGroupId(): string {
  return `mg-${globalThis.crypto.randomUUID()}`;
}

const CHANNEL_NAME = 'roadmap2u-db';

const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;

type LocalWriteHandler = (message: DbChangeMessage) => void;

/** BroadcastChannel never echoes to the posting tab — this registry is how
 *  THIS tab observes its own writes (the sync engine's push trigger). */
const localHandlers = new Set<LocalWriteHandler>();

export function onLocalWrite(handler: LocalWriteHandler): () => void {
  localHandlers.add(handler);
  return () => localHandlers.delete(handler);
}

export function broadcastChange(message: DbChangeMessage): void {
  const normalized =
    message.store === 'meta' || message.mutationGroupId?.trim()
      ? message
      : {
          ...message,
          mutationGroupId: createMutationGroupId(),
        };
  for (const handler of localHandlers) handler(normalized);
  channel?.postMessage(normalized);
}

/** Publish every store touched by one already-committed transaction with the
 * same operation id. A later transaction, even over identical rows, calls
 * this again and receives a new id. */
export function broadcastMutation(
  messages: readonly Omit<DbChangeMessage, 'mutationGroupId'>[],
): string {
  const mutationGroupId = createMutationGroupId();
  for (const message of messages) broadcastChange({ ...message, mutationGroupId });
  return mutationGroupId;
}

/** Cross-tab ONLY — for changes that arrived FROM outside (a pull applying
 *  server records). Skipping the local handlers matters: routing a pull
 *  through them re-marked every pulled id dirty and echoed a full redundant
 *  re-push after every sync round. */
export function broadcastRemote(message: DbChangeMessage): void {
  channel?.postMessage(message);
}

export function onDbChange(handler: (message: DbChangeMessage) => void): () => void {
  const listener = (event: MessageEvent) => handler(event.data as DbChangeMessage);
  channel?.addEventListener('message', listener);
  return () => channel?.removeEventListener('message', listener);
}
