import { Component, inject, signal } from '@angular/core';
import { inputValue } from '../../shared/ui/dom';
import { Switch } from '../../shared/ui/switch';
import { ConfirmSheet } from '../../shared/ui/confirm-sheet';
import { RouterLink } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';
import { SettingsService } from '../../core/repos/settings.service';
import { ThemeService } from '../../core/theme/theme.service';
import { TreesRepo } from '../../core/repos/trees.repo';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { BackupService } from '../../core/repos/backup.service';
import { ToastService } from '../../shared/ui/toast.service';
import { SwUpdate } from '@angular/service-worker';
import { AccompanimentService } from '../../core/accompaniment.service';
import { Lang, MotionPref, TextSize, ThemeName, Tree } from '../../core/db/schema';
import { APP_VERSION } from '../../core/version';
import { AuthService } from '../../core/auth/auth.service';
import { APP_CONFIG } from '../../core/config';
import { resetMockCloud } from '../../core/api/mock-cloud';
import { FamiliaCard } from '../familia/familia-card';
import { AmigosCard } from '../amigos/amigos-card';
import { SyncService } from '../../core/sync/sync.service';
import { FamilyService } from '../../core/family.service';
import { AccountClosureService } from '../../core/account-closure.service';
import type { AccountClosureState } from '../../core/api/contracts';

@Component({
  selector: 'app-settings',
  imports: [RouterLink, FamiliaCard, AmigosCard, ConfirmSheet, Switch],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class SettingsPage {
  protected readonly inputValue = inputValue;
  protected readonly version = APP_VERSION;
  protected readonly bugReportUrl =
    'https://docs.google.com/forms/d/e/1FAIpQLSelXiTkj1W9hKmgw1z_fLVFKy_a2bpWDFT8FdSABTLteHxmew/viewform';
  protected readonly checkingUpdate = signal(false);
  private readonly swUpdate = inject(SwUpdate);
  protected readonly i18n = inject(I18nService);

  /** One tap: check, and if something new exists, activate + reload. */
  protected async checkNow(): Promise<void> {
    if (this.checkingUpdate()) return;
    this.checkingUpdate.set(true);
    try {
      if (this.swUpdate.isEnabled && (await this.swUpdate.checkForUpdate())) {
        await this.swUpdate.activateUpdate().catch(() => {});
        location.reload();
        return;
      }
      this.toast.show({ message: this.i18n.t().settings.upToDate });
    } catch {
      this.toast.show({ message: this.i18n.t().settings.updateFailed });
    } finally {
      this.checkingUpdate.set(false);
    }
  }

  /** Nuclear but safe: unregister the SW + drop its caches, then reload.
   *  IndexedDB (trees, notes, settings) is untouched. */
  protected async repair(): Promise<void> {
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
      for (const reg of regs) await reg.unregister();
      if ('caches' in window) {
        for (const key of await caches.keys()) await caches.delete(key);
      }
    } finally {
      location.reload();
    }
  }
  protected readonly settings = inject(SettingsService);
  protected readonly theme = inject(ThemeService);
  protected readonly trees = inject(TreesRepo);
  protected readonly auth = inject(AuthService);
  protected readonly closure = inject(AccountClosureService);
  protected readonly sync = inject(SyncService);
  private readonly fam = inject(FamilyService);
  protected readonly isMock = APP_CONFIG.backend === 'mock';
  private readonly backup = inject(BackupService);
  private readonly toast = inject(ToastService);

  constructor() {
    void this.closure.hydrate();
  }

  protected closureStateText(state: AccountClosureState): string {
    switch (state) {
      case 'requested':
        return this.i18n.t().account.closureRequested;
      case 'purging':
        return this.i18n.t().account.closurePurging;
      case 'purgeComplete':
        return this.i18n.t().account.closurePurgeComplete;
      case 'completed':
        return this.i18n.t().account.closureCompleted;
    }
  }

  protected async doConnect(): Promise<void> {
    if (await this.sync.connect()) {
      this.toast.show({ message: this.i18n.t().nube.connectOk });
    }
  }

  protected async doSyncNow(): Promise<void> {
    await this.sync.syncNow();
  }

  protected async doDisconnect(): Promise<void> {
    await this.sync.disconnect();
    this.toast.show({ message: this.i18n.t().nube.disconnectOk });
  }

  protected lastSyncText(): string {
    const at = this.sync.lastSyncAt();
    if (!at) return this.i18n.t().nube.neverSynced;
    const locale = this.i18n.lang() === 'en' ? 'en' : 'es';
    const time = new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    return this.i18n.fill(this.i18n.t().nube.lastSync, { time });
  }

  /** Rehearsal mode only: wipe the practice cloud; it reseeds on next use.
   *  Also signs out — the session's user may no longer exist afterwards —
   *  and resets the device-side bookkeeping (link, cursor, family cache):
   *  kept against a reseeded cloud they'd skip records or paint ghosts. */
  /** Confirm sheet open for the practice-cloud reset — one tap used to sign
   *  out and wipe with no question asked (every other destructive action
   *  gets a confirm). */
  protected readonly confirmingMockReset = signal(false);

  protected async resetMockCloud(): Promise<void> {
    this.confirmingMockReset.set(false);
    await this.auth.signOut();
    await this.sync.forgetEverything();
    await this.fam.clearCache();
    const result = await resetMockCloud();
    this.toast.show({
      message:
        result === 'blocked'
          ? this.i18n.t().settings.mockResetBlocked
          : this.i18n.t().settings.mockResetDone,
    });
  }

  protected readonly importing = signal(false);
  /** Tree pending permanent deletion (confirm sheet open). */
  protected readonly deleting = signal<Tree | null>(null);
  private readonly nodes = inject(NodesRepo);
  private readonly accompaniment = inject(AccompanimentService);

  /** True when the browser refused notifications — whispers stay in-app. */
  protected readonly whispersDenied = signal(
    'Notification' in window && Notification.permission === 'denied',
  );

  protected async toggleWhispers(): Promise<void> {
    if (this.settings.settings().whispersEnabled) {
      await this.accompaniment.disable();
    } else {
      await this.accompaniment.enable();
      this.whispersDenied.set('Notification' in window && Notification.permission === 'denied');
    }
  }

  protected setWhisperRhythm(rhythm: 'often' | 'sometimes' | 'daily' | 'surprise'): void {
    void this.settings.patch({ whisperRhythm: rhythm });
  }

  protected setTheme(theme: ThemeName): void {
    void this.theme.setTheme(theme);
  }

  protected setLang(lang: Lang): void {
    void this.i18n.set(lang);
  }

  protected setMotion(pref: MotionPref): void {
    void this.settings.patch({ reduceMotion: pref });
  }

  protected setTextSize(size: TextSize): void {
    void this.theme.setTextSize(size);
  }

  protected toggleDyslexia(): void {
    void this.settings.patch({ dyslexiaFont: !this.settings.settings().dyslexiaFont });
  }

  protected setTimerDefault(value: number): void {
    if (value >= 1 && value <= 180) void this.settings.patch({ timerDefaultMinutes: value });
  }

  /** The golden approach-bridge: how early the parakeet turns and the ring
   *  warms. A hyperfocus exit-ramp — visual only, never a sound. */
  protected setBridge(minutes: 2 | 5): void {
    void this.settings.patch({ bridgeMinutes: minutes });
  }

  protected toggleTimeCompass(): void {
    void this.settings.patch({ timeCompass: !this.settings.settings().timeCompass });
  }

  protected exportData(): void {
    void this.backup.download();
  }

  protected toggleBackupReminders(): void {
    void this.settings.patch({ backupReminders: !this.settings.settings().backupReminders });
  }

  /** «Última copia: …» — or the honest no-copy-yet line. */
  protected lastBackupText(): string {
    const at = this.settings.settings().lastBackupAt;
    if (!at) return this.i18n.t().settings.noBackupYet;
    const locale = this.i18n.lang() === 'en' ? 'en' : 'es';
    const date = new Date(at).toLocaleDateString(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    return this.i18n.fill(this.i18n.t().settings.lastBackupLine, { date });
  }

  protected branchCountOf(tree: Tree): number {
    return this.nodes.all().filter((n) => n.treeId === tree.id).length;
  }

  /** In-flight latch — a double-tap downloaded two pre-delete backups. */
  private deletingBusy = false;

  /** The ONLY irreversible action in the app — backup first, always. */
  protected async deleteForever(): Promise<void> {
    const tree = this.deleting();
    if (!tree || this.deletingBusy) return;
    this.deletingBusy = true;
    try {
      await this.deleteForeverInner(tree);
    } finally {
      this.deletingBusy = false;
    }
  }

  private async deleteForeverInner(tree: Tree): Promise<void> {
    await this.backup.download('roadmap2u-pre-delete');
    const treeNodes = this.nodes.all().filter((n) => n.treeId === tree.id);
    await this.nodes.tombstoneMany(treeNodes);
    await this.trees.tombstone(tree);
    this.deleting.set(null);
    this.toast.show({
      message: this.i18n.fill(this.i18n.t().settings.deletedToast, { name: tree.name }),
    });
  }

  protected askMockReset(): void {
    this.confirmingMockReset.set(true);
  }

  protected async onImportFile(event: Event): Promise<void> {
    const inputEl = event.target as HTMLInputElement;
    const file = inputEl.files?.[0];
    inputEl.value = '';
    if (!file) return;
    this.importing.set(true);
    try {
      await this.backup.importReplace(await file.text());
      this.toast.show({ message: this.i18n.t().settings.importOk });
    } catch {
      this.toast.show({ message: this.i18n.t().settings.importError });
    } finally {
      this.importing.set(false);
    }
  }
}
