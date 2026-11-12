import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { PwaInstallService } from './pwa-install.service';

describe('app installation', () => {
  it('retains the browser prompt for a user gesture and removes the offer after installation', async () => {
    const install = TestBed.inject(PwaInstallService);
    const prompt = vi.fn(async () => undefined);
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(install.canPrompt()).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    await install.install();
    expect(prompt).toHaveBeenCalledOnce();
    expect(install.canPrompt()).toBe(false);

    window.dispatchEvent(new Event('appinstalled'));
    expect(install.installed()).toBe(true);
  });
});
