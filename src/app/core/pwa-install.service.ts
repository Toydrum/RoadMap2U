import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

interface InstallPrompt extends Event {
  prompt(): Promise<unknown>;
}

const FOREST_INSTALL_GUIDE_SEEN = 'rm2u.forest-install-guide-seen';

@Injectable({ providedIn: 'root' })
export class PwaInstallService {
  private readonly standaloneMode = window.matchMedia?.('(display-mode: standalone)');
  private readonly installedState = signal(
    this.standaloneMode?.matches === true || (navigator as Navigator & { standalone?: boolean }).standalone === true,
  );
  private readonly availablePrompt = signal<InstallPrompt | null>(null);
  private forestGuideClaimed = false;
  readonly installed = this.installedState.asReadonly();
  readonly canPrompt = computed(() => !this.installed() && this.availablePrompt() !== null);

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

  claimForestGuide(): boolean {
    if (this.forestGuideClaimed || this.installed()) return false;
    this.forestGuideClaimed = true;
    try {
      if (localStorage.getItem(FOREST_INSTALL_GUIDE_SEEN) === '1') return false;
      localStorage.setItem(FOREST_INSTALL_GUIDE_SEEN, '1');
    } catch {
      // When storage is unavailable, remember the offer for this app session.
    }
    return true;
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
