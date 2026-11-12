import { TestBed } from '@angular/core/testing';
import { SwUpdate, type VersionEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { I18nService } from './i18n/i18n.service';
import { ES } from './i18n/es';
import { ToastService } from '../shared/ui/toast.service';
import { APP_UPDATE_RUNTIME, UpdateService } from './update.service';

function setup() {
  const versionUpdates = new Subject<VersionEvent>();
  const unrecoverable = new Subject<{ reason: string }>();
  const checkForUpdate = vi.fn(async () => false);
  const reload = vi.fn();
  const online = vi.fn(() => true);
  const storageReady = vi.fn(async () => true);
  TestBed.configureTestingModule({
    providers: [
      { provide: SwUpdate, useValue: { isEnabled: true, versionUpdates, unrecoverable, checkForUpdate } },
      { provide: I18nService, useValue: { t: () => ES } },
      { provide: APP_UPDATE_RUNTIME, useValue: { reload, online, storageReady } },
    ],
  });
  return { service: TestBed.inject(UpdateService), checkForUpdate, unrecoverable, reload, online, storageReady };
}

describe('updates', () => {
  it('offers a downloaded version without reloading until the user applies it', async () => {
    const { service, checkForUpdate, reload } = setup();
    checkForUpdate.mockResolvedValue(true);

    expect(await service.check()).toBe('ready');
    expect(service.status()).toBe('ready');
    expect(reload).not.toHaveBeenCalled();
    await service.apply();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('offers recovery without forcing a reload or discarding work when storage is unavailable', async () => {
    const { service, unrecoverable, reload, storageReady } = setup();
    service.init();
    unrecoverable.next({ reason: 'uncached resource' });
    expect(service.status()).toBe('recovery');
    expect(reload).not.toHaveBeenCalled();
    storageReady.mockResolvedValue(false);
    await service.apply();
    expect(reload).not.toHaveBeenCalled();
    expect(TestBed.inject(ToastService).current()?.message).toBe(ES.app.memoryOnly);
  });

  it('does not reload an offline tab or claim it checked for an update', async () => {
    const { service, checkForUpdate, reload, online } = setup();
    online.mockReturnValue(false);
    expect(await service.check()).toBe('unavailable');
    expect(checkForUpdate).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    checkForUpdate.mockResolvedValue(true);
    expect(await service.check()).toBe('ready');
    online.mockReturnValue(false);
    await service.apply();
    expect(reload).not.toHaveBeenCalled();
  });

  it('ends a check if an unavailable browser worker never answers', async () => {
    vi.useFakeTimers();
    try {
      const { service, checkForUpdate } = setup();
      checkForUpdate.mockImplementation(() => new Promise(() => undefined));
      const result = service.check();
      expect(service.checking()).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await result).toBe('unavailable');
      expect(service.checking()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
