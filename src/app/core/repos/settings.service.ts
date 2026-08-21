import { DestroyRef, Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { broadcastChange } from '../db/broadcast';
import { LocalWritesQuiescedError, onAccountClosureQuiesce } from '../db/account-closure-fence';
import { get, put } from '../db/idb';
import { DEFAULT_SETTINGS, Settings } from '../db/schema';

interface SettingsRecord {
  key: 'settings';
  value: Settings;
}

export interface SettingsStorage {
  read(): Promise<SettingsRecord | null>;
  write(record: SettingsRecord): Promise<void>;
}

export const SETTINGS_STORAGE = new InjectionToken<SettingsStorage>('SETTINGS_STORAGE', {
  providedIn: 'root',
  factory: () => ({
    read: async () => (await get<SettingsRecord>('meta', 'settings')) ?? null,
    write: (record) => put('meta', record),
  }),
});

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly storage = inject(SETTINGS_STORAGE);
  private readonly state = signal<Settings>(DEFAULT_SETTINGS);
  private readonly pendingWrites = new Set<Promise<void>>();
  private generation = 0;
  private accountClosureQuiesced = false;

  readonly settings = this.state.asReadonly();
  readonly lang = computed(() => this.state().lang);
  readonly theme = computed(() => this.state().theme);
  readonly textSize = computed(() => this.state().textSize);
  readonly dyslexiaFont = computed(() => this.state().dyslexiaFont);

  constructor() {
    const stopAccountClosure = onAccountClosureQuiesce(() => this.beginAccountClosureReset());
    inject(DestroyRef).onDestroy(stopAccountClosure);
  }

  async load(): Promise<void> {
    const generation = this.generation;
    try {
      const record = await this.storage.read();
      if (generation === this.generation) {
        this.state.set(record ? { ...DEFAULT_SETTINGS, ...record.value } : DEFAULT_SETTINGS);
      }
    } catch {
      /* storage unavailable — defaults, memory-only session */
    }
  }

  async patch(partial: Partial<Settings>): Promise<void> {
    if (this.accountClosureQuiesced) throw new LocalWritesQuiescedError();
    const generation = this.generation;
    // Merge over the DISK copy, not just memory: another tab may have
    // patched a behavioral key since we loaded.
    let base = this.state();
    try {
      const record = await this.storage.read();
      if (record) base = { ...DEFAULT_SETTINGS, ...record.value };
    } catch {
      /* memory-only session — merge over memory */
    }
    if (generation !== this.generation || this.accountClosureQuiesced) return;
    const next = { ...base, ...partial };
    try {
      const write = this.storage.write({ key: 'settings', value: next });
      this.pendingWrites.add(write);
      try {
        await write;
      } finally {
        this.pendingWrites.delete(write);
      }
    } catch (error) {
      if (error instanceof LocalWritesQuiescedError) throw error;
      /* memory-only session */
    }
    if (generation !== this.generation || this.accountClosureQuiesced) return;
    this.state.set(next);
    broadcastChange({ store: 'meta', ids: ['settings'] });
  }

  /** Memory half of terminal account cleanup; disk is cleared atomically by
   * LocalAccountDataService and must not be re-written here. */
  async resetAfterAccountClosure(): Promise<void> {
    this.beginAccountClosureReset();
    while (this.pendingWrites.size) await Promise.allSettled([...this.pendingWrites]);
    this.beginAccountClosureReset();
  }

  private beginAccountClosureReset(): void {
    this.accountClosureQuiesced = true;
    this.generation += 1;
    this.state.set(DEFAULT_SETTINGS);
  }
}
