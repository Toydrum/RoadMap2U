import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

interface InstallPrompt extends Event {
  prompt(): Promise<unknown>;
}

@Injectable({ providedIn: 'root' })
export class PwaInstallService {
  private readonly standaloneMode = window.matchMedia?.('(display-mode: standalone)');
  private readonly installedState = signal(
    this.standaloneMode?.matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true,
  );
  private readonly availablePrompt = signal<InstallPrompt | null>(null);
  readonly installed = this.installedState.asReadonly();
  readonly canPrompt = computed(() => !this.installed() && this.availablePrompt() !== null);
  readonly isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  constructor() {
    const capture = (event: Event) => {
      const prompt = event as InstallPrompt;
      if (this.installed() || typeof prompt.prompt !== 'function') return;
      event.preventDefault();
      this.availablePrompt.set(prompt);
    };
    const markInstalled = () => {
      this.installedState.set(true);
      this.availablePrompt.set(null);
    };
    const onDisplayMode = (event: MediaQueryListEvent) => {
      if (event.matches) markInstalled();
    };
    window.addEventListener('beforeinstallprompt', capture);
    window.addEventListener('appinstalled', markInstalled);
    this.standaloneMode?.addEventListener?.('change', onDisplayMode);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('beforeinstallprompt', capture);
      window.removeEventListener('appinstalled', markInstalled);
      this.standaloneMode?.removeEventListener?.('change', onDisplayMode);
    });
  }

  async install(): Promise<void> {
    const event = this.availablePrompt();
    if (!event || this.installed()) return;
    this.availablePrompt.set(null);
    try {
      await event.prompt();
    } catch {
      // The browser menu remains available when the saved prompt expires.
    }
  }
}
