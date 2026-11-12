import { Component, computed, inject, signal } from '@angular/core';
import { inputValue } from '../../shared/ui/dom';
import { Switch } from '../../shared/ui/switch';
import { ConfirmSheet } from '../../shared/ui/confirm-sheet';
import { RouterLink } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';
import { SettingsService } from '../../core/repos/settings.service';
import { ThemeService } from '../../core/theme/theme.service';
import { TreesRepo } from '../../core/repos/trees.repo';
import { NodesRepo } from '../../core/repos/nodes.repo';
import { BackupService, type BackupImportPreview } from '../../core/repos/backup.service';
import { ToastService } from '../../shared/ui/toast.service';
import { AccompanimentService } from '../../core/accompaniment.service';
import { storageAvailable } from '../../core/db/idb';
import { PwaInstallService } from '../../core/pwa-install.service';
import { UpdateService } from '../../core/update.service';
import { Lang, MotionPref, TextSize, ThemeName, Tree } from '../../core/db/schema';
import { APP_VERSION } from '../../core/version';
import { AuthService } from '../../core/auth/auth.service';
import { APP_CONFIG } from '../../core/config';
import { resetMockCloud } from '../../core/api/mock-cloud';
import { SyncService } from '../../core/sync/sync.service';
import { FamilyService } from '../../core/family.service';
import { AccountClosureService } from '../../core/account-closure.service';
import type { AccountClosureState } from '../../core/api/contracts';
import { PrivacyService } from '../../core/privacy.service';
import { PrivacyPanel } from '../../shared/ui/privacy-panel';
import { AccountAccessSummary } from '../../shared/ui/account-access-summary';
import { forestQuotaMessage, restoreTreeWithFeedback } from '../forest/forest-quota-feedback';
import { SyncConflictReview } from './sync-conflict-review';

@Component({
  selector: 'app-settings',
  imports: [RouterLink, ConfirmSheet, Switch, PrivacyPanel, AccountAccessSummary, SyncConflictReview],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class SettingsPage {
  protected readonly inputValue = inputValue;
  protected readonly version = APP_VERSION;
  protected readonly bugReportUrl =
    'https://docs.google.com/forms/d/e/1FAIpQLSelXiTkj1W9hKmgw1z_fLVFKy_a2bpWDFT8FdSABTLteHxmew/viewform';
  protected readonly updates = inject(UpdateService);
  protected readonly install = inject(PwaInstallService);
  protected readonly i18n = inject(I18nService);

  protected async checkNow(): Promise<void> {
    const result = await this.updates.check();
    if (result === 'current') {
      this.toast.show({ message: this.i18n.t().settings.upToDate });
    } else if (result === 'unavailable') {
      this.toast.show({ message: this.i18n.t().settings.updateFailed });
    }
  }
  protected readonly settings = inject(SettingsService);
  protected readonly theme = inject(ThemeService);
  protected readonly trees = inject(TreesRepo);
  protected readonly auth = inject(AuthService);
  protected readonly closure = inject(AccountClosureService);
  protected readonly sync = inject(SyncService);
  protected readonly privacy = inject(PrivacyService);
  private readonly fam = inject(FamilyService);
  protected readonly isMock = APP_CONFIG.backend === 'mock';
  private readonly backup = inject(BackupService);
  private readonly toast = inject(ToastService);
  private readonly storageReady = signal<boolean | null>(null);
  protected readonly exporting = signal(false);
  protected readonly forestStatusText = computed(() => {
    const copy = this.i18n.t();
    const storage = this.storageReady();
    if (storage === null) return '';
    if (!storage) return copy.app.memoryOnly;
    switch (this.sync.forestStatus()) {
      case 'local': return copy.settings.syncLocal;
      case 'pending': return this.sync.phase() === 'offline' ? copy.nube.offlineHint : copy.settings.syncPending;
      case 'current': return copy.premiumCloud.current;
      case 'attention': return copy.settings.syncAttention;
      case 'local-only': return copy.nube.conflicts.someLocal;
    }
  });

  constructor() {
    void this.closure.hydrate();
    void storageAvailable().then((ready) => this.storageReady.set(ready));
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
    if (!this.privacy.status()?.canUseCloud || this.privacy.cloudBlocked()) return;
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
    const time = new Date(at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
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
  protected readonly importPreview = signal<{ json: string; details: BackupImportPreview } | null>(null);
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

  protected async exportData(): Promise<void> {
    if (this.exporting()) return;
    this.exporting.set(true);
    try {
      await this.backup.download(undefined, { allowMemoryCopy: true });
    } catch {
      this.toast.show({ message: this.i18n.t().account.errors.unknown });
    } finally {
      this.exporting.set(false);
    }
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

  protected async restoreArchivedTree(tree: Tree): Promise<void> {
    await restoreTreeWithFeedback(tree, this.trees, this.i18n, this.toast);
  }

  protected async onImportFile(event: Event): Promise<void> {
    const inputEl = event.target as HTMLInputElement;
    const file = inputEl.files?.[0];
    inputEl.value = '';
    if (!file || this.importing()) return;
    this.importing.set(true);
    try {
      const json = await file.text();
      this.importPreview.set({ json, details: this.backup.previewImport(json) });
    } catch (error) {
      this.toast.show({ message: forestQuotaMessage(this.i18n, error) ?? this.i18n.t().settings.importError });
    } finally {
      this.importing.set(false);
    }
  }

  protected importPreviewDate(exportedAt: string): string | null {
    const date = new Date(exportedAt);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(this.i18n.lang(), { dateStyle: 'medium' });
  }

  protected async confirmImport(): Promise<void> {
    const preview = this.importPreview();
    if (!preview || this.importing()) return;
    this.importPreview.set(null);
    this.importing.set(true);
    try {
      await this.backup.importReplace(preview.json);
      this.toast.show({ message: this.i18n.t().settings.importOk });
    } catch (error) {
      this.toast.show({
        message: forestQuotaMessage(this.i18n, error) ?? this.i18n.t().settings.importRestoreError,
      });
    } finally {
      this.importing.set(false);
    }
  }
}
