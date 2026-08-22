import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../db/schema';
import { SETTINGS_STORAGE, SettingsService, type SettingsStorage } from './settings.service';

describe('SettingsService terminal cleanup', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('drains an already-started settings write and never applies it after reset', async () => {
    let releaseWrite!: () => void;
    const storage: SettingsStorage = {
      read: vi.fn(async () => null),
      write: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseWrite = resolve;
          }),
      ),
    };
    TestBed.configureTestingModule({
      providers: [SettingsService, { provide: SETTINGS_STORAGE, useValue: storage }],
    });
    const service = TestBed.inject(SettingsService);

    const patch = service.patch({ lang: 'en' });
    await vi.waitFor(() => expect(storage.write).toHaveBeenCalledOnce());
    const reset = service.resetAfterAccountClosure();
    let resetFinished = false;
    void reset.then(() => (resetFinished = true));
    await Promise.resolve();

    expect(resetFinished).toBe(false);
    expect(service.settings()).toEqual(DEFAULT_SETTINGS);

    releaseWrite();
    await reset;
    await patch;
    expect(service.settings()).toEqual(DEFAULT_SETTINGS);
  });
});
