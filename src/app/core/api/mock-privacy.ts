import {
  ADULT_PRIVACY_VERSIONS,
  ApiError,
  type PrivacyStatus,
  type PrivacyConsentCommand,
  type PrivacyExportPage,
  type PrivateAdolescentInvitation,
  type PrivateAdolescentInvitationCommand,
  type PrivateAdolescentGuardianCommand,
  type PrivacyCommandBase,
} from './contracts';
import { USERNAME_PATTERN } from '../auth/auth-types';
import {
  privacyDocument,
  privacyCalendarDate,
  validAdolescentMajorityDate,
} from './privacy-document';
import {
  mockGet,
  mockGetAll,
  mockPutPrivacyDecision,
  mockAccountClosureKey,
  withMockAccountLocks,
  type MockUserRow,
  type MockRecordRow,
  type MockCoverageRow,
} from './mock-cloud';
interface State extends PrivacyStatus {
  declarationLanguage?: 'es' | 'en';
  declarationHash?: string;
  cloudLanguage?: 'es' | 'en';
  cloudHash?: string;
  erasedRevision?: number;
  adolescentAcceptedAt?: number;
  adolescentLanguage?: 'es' | 'en';
  adolescentHash?: string;
  guardianId?: string;
  guardianInstance?: string;
  guardianLanguage?: 'es' | 'en';
  guardianHash?: string;
  guardianRevision?: number;
  guardianAuthorization?: {
    method: 'account_attestation' | 'operator_verified';
    attestation?: Attestation;
  };
}
interface Attestation {
  subjectId: string;
  authenticatedAt: number;
  emailVerified: true;
  declaredName: string;
  relationship: 'parent' | 'legal_guardian';
  declaredAt: number;
}
interface Invitation extends PrivateAdolescentInvitation {
  guardianId: string;
  guardianInstance: string;
  language: 'es' | 'en';
  documentHash: string;
  request: string;
  representationVerifiedAt?: number;
  verificationCaseId?: string;
  attestation?: Attestation;
}
const declaredNameValid = (value: unknown): value is string =>
  typeof value === 'string' &&
  value === value.trim() &&
  value.length >= 3 &&
  value.length <= 160 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const premiumCurrent = (coverage: MockCoverageRow | undefined, accountId: string) =>
  coverage?.accountId === accountId &&
  ['active', 'grace_period', 'scheduled_end'].includes(coverage.state) &&
  (coverage.validUntil === null || coverage.validUntil > Date.now());
export const mockPrivateInvitationKey = (id: string) => `private-adolescent-invitation:${id}`;
const requestText = (value: object) =>
  JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
export class MockAdultPrivacy {
  constructor(
    private readonly mode: 'off' | 'enforce',
    private readonly adolescentMode: 'off' | 'enforce' = 'off',
    private readonly authentication?: (
      user: MockUserRow,
    ) => Promise<{ authenticatedAt?: number; emailVerified?: boolean }>,
  ) {}
  private async recentConfirmed(user: MockUserRow) {
    const evidence = await this.authentication?.(user);
    if (
      !Number.isSafeInteger(evidence?.authenticatedAt) ||
      evidence!.authenticatedAt! < Date.now() - 15 * 60000 ||
      evidence!.authenticatedAt! > Date.now() + 30000
    )
      throw new ApiError('REAUTHENTICATION_REQUIRED');
    if (evidence?.emailVerified !== true) throw new ApiError('EMAIL_VERIFICATION_REQUIRED');
    return evidence as { authenticatedAt: number; emailVerified: true };
  }
  private key(user: MockUserRow) {
    return `privacy:${encodeURIComponent(user.userId)}:${encodeURIComponent(user.accountInstanceId ?? '')}`;
  }
  private async state(user: MockUserRow) {
    return (await mockGet<{ key: string; value: State }>('kv', this.key(user)))?.value;
  }
  private async active(user: MockUserRow) {
    const current = await mockGet<MockUserRow>('users', user.userId);
    if (
      !current ||
      current.accountInstanceId !== user.accountInstanceId ||
      (await mockGet('kv', mockAccountClosureKey(user.userId, user.accountInstanceId ?? '')))
    )
      throw new ApiError('UNAUTHENTICATED');
    return current;
  }
  private async validate(command: PrivacyCommandBase, extra: string[]) {
    if (!command || !['es', 'en'].includes(command.language)) throw new ApiError('VALIDATION');
    const keys = [
      'commandId',
      'expectedRevision',
      'language',
      'noticeVersion',
      'termsVersion',
      'cloudConsentVersion',
      'documentHash',
      ...extra,
    ];
    const document = await privacyDocument(command.language);
    if (
      Object.keys(command).length !== keys.length ||
      Object.keys(command).some((key) => !keys.includes(key)) ||
      !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/.test(command.commandId) ||
      !Number.isSafeInteger(command.expectedRevision) ||
      command.expectedRevision < 0 ||
      Object.entries(ADULT_PRIVACY_VERSIONS).some(
        ([key, value]) => (command as unknown as Record<string, unknown>)[key] !== value,
      ) ||
      command.documentHash !== document.hash
    )
      throw new ApiError('VALIDATION');
    return document;
  }
  private privateAdmission(user: MockUserRow, state?: State) {
    return (
      user.accountType === 'minor' &&
      user.privacyMode === 'adolescent_private' &&
      !!state?.adolescentAcceptedAt &&
      state.majorityAt === user.majorityAt &&
      !!user.majorityAt &&
      user.majorityAt > privacyCalendarDate()
    );
  }
  private async parent(state: State) {
    const user = state.guardianId
      ? await mockGet<MockUserRow>('users', state.guardianId)
      : undefined;
    if (!user || user.accountInstanceId !== state.guardianInstance)
      throw new ApiError('CLOUD_CONSENT_REQUIRED');
    try {
      await this.active(user);
    } catch {
      throw new ApiError('CLOUD_CONSENT_REQUIRED');
    }
    const privacy = await this.state(user);
    if (
      user.accountType !== 'adult' ||
      !privacy?.declarationLanguage ||
      privacy.declarationHash !== (await privacyDocument(privacy.declarationLanguage)).hash
    )
      throw new ApiError('CLOUD_CONSENT_REQUIRED');
    return { user, privacy };
  }
  async participants(userId: string): Promise<string[]> {
    const user = await mockGet<MockUserRow>('users', userId);
    const state = user ? await this.state(user) : undefined;
    return state?.guardianId ? [state.guardianId] : [];
  }
  async status(user: MockUserRow, language: 'es' | 'en' = 'es'): Promise<PrivacyStatus> {
    if (language !== 'es' && language !== 'en') throw new ApiError('VALIDATION');
    const item = await this.state(user);
    const adolescent = this.privateAdmission(user, item);
    const declared =
      user.accountType === 'adult' &&
      !!item?.declarationLanguage &&
      item.declarationHash === (await privacyDocument(item.declarationLanguage)).hash;
    let guardianCurrent =
      adolescent &&
      item?.guardianConsent === 'granted' &&
      !!item.guardianLanguage &&
      item.guardianHash === (await privacyDocument(item.guardianLanguage)).hash;
    if (guardianCurrent) {
      try {
        await this.parent(item!);
      } catch {
        guardianCurrent = false;
      }
    }
    const adolescentUnderstood =
      adolescent &&
      !!item?.adolescentLanguage &&
      item.adolescentHash === (await privacyDocument(item.adolescentLanguage)).hash;
    const current =
      !!item?.cloudLanguage &&
      item.cloudHash === (await privacyDocument(item.cloudLanguage)).hash &&
      (!adolescent || adolescentUnderstood);
    const cloudConsent =
      item?.cloudConsent === 'granted' && (!(declared || guardianCurrent) || !current)
        ? 'version_review_required'
        : (item?.cloudConsent ?? 'absent');
    const erasure = item?.erasure ?? 'none';
    let cloudCoverage: PrivacyStatus['cloudCoverage'] = user.privacyMode
      ? { kind: 'responsible_premium', state: 'unavailable', validUntil: null }
      : undefined;
    if (adolescent && guardianCurrent && item?.guardianId) {
      const coverage = await mockGet<MockCoverageRow>('coverages', item.guardianId);
      if (
        coverage?.accountId === item.guardianId &&
        ['active', 'grace', 'scheduled_end'].includes(coverage.state) &&
        (coverage.validUntil === null ||
          (Number.isSafeInteger(coverage.validUntil) && coverage.validUntil > Date.now()))
      ) {
        cloudCoverage = {
          kind: 'responsible_premium',
          state: 'active',
          validUntil: coverage.validUntil,
        };
      }
    }
    return {
      userId: user.userId,
      scope:
        user.accountType === 'adult' ? 'adult' : adolescent ? 'adolescent_private' : 'unsupported',
      enforcement: this.mode,
      revision: item?.revision ?? 0,
      adultDeclared: declared,
      cloudConsent,
      erasure,
      canUseCloud:
        (declared ||
          (guardianCurrent &&
            this.adolescentMode === 'enforce' &&
            cloudCoverage?.state === 'active')) &&
        current &&
        cloudConsent === 'granted' &&
        ['none', 'completed'].includes(erasure),
      versions: ADULT_PRIVACY_VERSIONS,
      documentHash: (await privacyDocument(language)).hash,
      updatedAt: item?.updatedAt ?? null,
      ...(cloudCoverage ? { cloudCoverage } : {}),
      ...(user.privacyMode
        ? {
            privateOnly: true,
            majorityAt: user.majorityAt,
            invitationId: item?.invitationId,
            adolescentUnderstood,
            guardianConsent: !adolescent
              ? ('ended' as const)
              : guardianCurrent
                ? ('granted' as const)
                : item?.guardianConsent === 'revoked'
                  ? ('revoked' as const)
                  : ('version_review_required' as const),
          }
        : {}),
    };
  }
  async change(user: MockUserRow, command: PrivacyConsentCommand): Promise<PrivacyStatus> {
    const document = await this.validate(command, [
      'action',
      ...(command.action === 'declare_adult'
        ? ['declareAdult', 'acceptTerms']
        : command.action === 'grant_cloud'
          ? ['accepted']
          : command.action === 'accept_adolescent'
            ? ['invitationId', 'acceptTerms', 'understandsPrivacy']
            : []),
    ]);
    if (command.action === 'accept_adolescent') return this.accept(user, command);
    if (
      !['declare_adult', 'grant_cloud', 'revoke_cloud', 'erase_cloud'].includes(command.action) ||
      (command.action === 'declare_adult' &&
        (command.declareAdult !== true || command.acceptTerms !== true)) ||
      (command.action === 'grant_cloud' && command.accepted !== true)
    )
      throw new ApiError('VALIDATION');
    return withMockAccountLocks(
      [user.userId, ...(await this.participants(user.userId))],
      async () => {
        user = await this.active(user);
        const old = await this.state(user);
        const adolescent = this.privateAdmission(user, old);
        const due =
          user.privacyMode === 'adolescent_private' &&
          !!user.majorityAt &&
          user.majorityAt <= privacyCalendarDate();
        if (
          user.accountType !== 'adult' &&
          !adolescent &&
          !(due && command.action === 'declare_adult') &&
          !(user.privacyMode && ['revoke_cloud', 'erase_cloud'].includes(command.action))
        )
          throw new ApiError('FORBIDDEN');
        if (command.action === 'declare_adult' && user.accountType !== 'adult' && !due)
          throw new ApiError('FORBIDDEN');
        const key = this.key(user);
        const evidenceKey = `${key}:command:${command.commandId}`;
        const request = requestText(command);
        const previous = await mockGet<{ key: string; value: { request: string } }>(
          'kv',
          evidenceKey,
        );
        if (previous) {
          if (previous.value.request !== request) throw new ApiError('PRIVACY_REVISION_CONFLICT');
          return this.status(user, command.language);
        }
        const current = await this.status(user, command.language);
        if (
          current.revision !== command.expectedRevision ||
          current.revision >= Number.MAX_SAFE_INTEGER
        )
          throw new ApiError('PRIVACY_REVISION_CONFLICT');
        if (command.action === 'grant_cloud' && !adolescent && !current.adultDeclared)
          throw new ApiError('ADULT_DECLARATION_REQUIRED');
        if (
          command.action === 'grant_cloud' &&
          adolescent &&
          (this.adolescentMode !== 'enforce' || current.guardianConsent !== 'granted')
        )
          throw new ApiError('CLOUD_CONSENT_REQUIRED');
        if (command.action === 'grant_cloud' && adolescent && !current.adolescentUnderstood)
          throw new ApiError('VALIDATION');
        if (command.action === 'grant_cloud' && !['none', 'completed'].includes(current.erasure))
          throw new ApiError('PRIVACY_ERASURE_PENDING');
        const now = Date.now();
        const next: State = {
          ...(await this.state(user)),
          ...current,
          revision: current.revision + 1,
          updatedAt: now,
        };
        if (command.action === 'declare_adult') {
          Object.assign(next, {
            adultDeclared: true,
            declarationLanguage: command.language,
            declarationHash: document.hash,
          });
          if (due) {
            user = { ...user, accountType: 'adult', socialEnabled: false };
            Object.assign(next, { guardianConsent: 'ended', cloudConsent: 'revoked' });
          }
        }
        if (command.action === 'grant_cloud')
          Object.assign(next, {
            cloudConsent: 'granted',
            cloudLanguage: command.language,
            cloudHash: document.hash,
          });
        if (command.action === 'revoke_cloud' || command.action === 'erase_cloud')
          next.cloudConsent = 'revoked';
        if (command.action === 'erase_cloud')
          Object.assign(next, { erasure: 'completed', erasedRevision: next.revision });
        const evidence = {
          userId: user.userId,
          action: command.action,
          revision: next.revision,
          updatedAt: now,
          document: document.document,
          documentHash: document.hash,
          authentication: 'verified_mock_subject',
          request,
        };
        await mockPutPrivacyDecision(
          [
            { key, value: next },
            { key: evidenceKey, value: evidence },
          ],
          command.action === 'erase_cloud' ? user.userId : undefined,
          due ? user : undefined,
        );
        return this.status(user, command.language);
      },
    );
  }
  async invite(
    user: MockUserRow,
    command: PrivateAdolescentInvitationCommand,
  ): Promise<PrivateAdolescentInvitation> {
    if (this.adolescentMode !== 'enforce') throw new ApiError('FORBIDDEN');
    const authentication = await this.recentConfirmed(user);
    await this.validate(command, [
      'recipientUsername',
      'majorityAt',
      'guardianName',
      'guardianRelationship',
      'representsMinor',
      'authorizesCloud',
    ]);
    if (
      !USERNAME_PATTERN.test(command.recipientUsername) ||
      command.recipientUsername === user.username ||
      !validAdolescentMajorityDate(command.majorityAt) ||
      command.representsMinor !== true ||
      command.authorizesCloud !== true ||
      !declaredNameValid(command.guardianName) ||
      !['parent', 'legal_guardian'].includes(command.guardianRelationship) ||
      command.expectedRevision !== 0
    )
      throw new ApiError('VALIDATION');
    const bytes = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${user.userId}:${command.commandId}`),
    );
    const id = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
    return withMockAccountLocks([user.userId], async () => {
      user = await this.active(user);
      if (!(await this.status(user)).adultDeclared) throw new ApiError('FORBIDDEN');
      const key = mockPrivateInvitationKey(id);
      const old = await mockGet<{ key: string; value: Invitation }>('kv', key);
      if (old) {
        if (
          old.value.request !== requestText(command) ||
          old.value.guardianInstance !== user.accountInstanceId
        )
          throw new ApiError('PRIVACY_REVISION_CONFLICT');
        return this.invitationView(old.value);
      }
      if (!premiumCurrent(await mockGet<MockCoverageRow>('coverages', user.userId), user.userId))
        throw new ApiError('CAPABILITY_REQUIRED');
      const all = await mockGetAll<{ key: string; value: Invitation }>('kv');
      if (
        all.filter(
          (row) =>
            row.key.startsWith('private-adolescent-invitation:') &&
            row.value.guardianId === user.userId &&
            row.value.expiresAt > Date.now() + 6 * 86400000,
        ).length >= 5
      )
        throw new ApiError('RATE_LIMITED');
      const item: Invitation = {
        invitationId: id,
        recipientUsername: command.recipientUsername,
        majorityAt: command.majorityAt,
        state: 'authorized',
        authorizationMethod: 'account_attestation',
        attestation: {
          subjectId: user.userId,
          ...authentication,
          declaredName: command.guardianName,
          relationship: command.guardianRelationship,
          declaredAt: Date.now(),
        },
        revision: 1,
        expiresAt: Date.now() + 7 * 86400000,
        guardianId: user.userId,
        guardianInstance: user.accountInstanceId ?? '',
        language: command.language,
        documentHash: command.documentHash,
        request: requestText(command),
      };
      await mockPutPrivacyDecision([{ key, value: item }]);
      return this.invitationView(item);
    });
  }
  private async invitationView(item: Invitation): Promise<PrivateAdolescentInvitation> {
    const view: PrivateAdolescentInvitation = {
      invitationId: item.invitationId,
      recipientUsername: item.recipientUsername,
      majorityAt: item.majorityAt,
      state: item.state !== 'accepted' && item.expiresAt <= Date.now() ? 'expired' : item.state,
      revision: item.revision,
      expiresAt: item.expiresAt,
      ...(item.authorizationMethod ? { authorizationMethod: item.authorizationMethod } : {}),
      ...(item.adolescentId ? { adolescentId: item.adolescentId } : {}),
    };
    if (item.state === 'accepted' && item.adolescentId) {
      const user = await mockGet<MockUserRow>('users', item.adolescentId);
      const state = user ? await this.state(user) : undefined;
      if (
        user &&
        state?.guardianId === item.guardianId &&
        state.guardianInstance === item.guardianInstance
      ) {
        const current = await this.status(user, item.language);
        view.consentRevision = current.revision;
        view.guardianConsent = current.guardianConsent;
      }
    }
    return view;
  }
  async invitations(user: MockUserRow): Promise<PrivateAdolescentInvitation[]> {
    await this.active(user);
    const all = await mockGetAll<{ key: string; value: Invitation }>('kv');
    return Promise.all(
      all
        .filter(
          (row) =>
            row.key.startsWith('private-adolescent-invitation:') &&
            row.value.guardianId === user.userId &&
            row.value.guardianInstance === user.accountInstanceId,
        )
        .map((row) => this.invitationView(row.value)),
    );
  }
  private async accept(
    user: MockUserRow,
    command: Extract<PrivacyConsentCommand, { action: 'accept_adolescent' }>,
  ): Promise<PrivacyStatus> {
    if (this.adolescentMode !== 'enforce') throw new ApiError('FORBIDDEN');
    await this.recentConfirmed(user);
    if (
      command.acceptTerms !== true ||
      command.understandsPrivacy !== true ||
      !/^[a-f0-9]{64}$/.test(command.invitationId)
    )
      throw new ApiError('VALIDATION');
    const key = mockPrivateInvitationKey(command.invitationId);
    const initial = await mockGet<{ key: string; value: Invitation }>('kv', key);
    if (!initial) throw new ApiError('FORBIDDEN');
    return withMockAccountLocks([user.userId, initial.value.guardianId], async () => {
      user = await this.active(user);
      const evidenceKey = `${this.key(user)}:command:${command.commandId}`;
      const replay = await mockGet<{ key: string; value: { request: string } }>('kv', evidenceKey);
      if (replay) {
        if (replay.value.request !== requestText(command))
          throw new ApiError('PRIVACY_REVISION_CONFLICT');
        return this.status(user, command.language);
      }
      const old = await this.state(user);
      if (this.privateAdmission(user, old)) {
        if (
          old!.invitationId !== command.invitationId ||
          old!.revision !== command.expectedRevision ||
          old!.revision >= Number.MAX_SAFE_INTEGER
        )
          throw new ApiError('CONFLICT');
        await this.parent(old!);
        const next = {
          ...old!,
          revision: old!.revision + 1,
          updatedAt: Date.now(),
          adolescentLanguage: command.language,
          adolescentHash: command.documentHash,
          cloudConsent: 'revoked' as const,
        };
        await mockPutPrivacyDecision([
          { key: this.key(user), value: next },
          {
            key: evidenceKey,
            value: {
              action: command.action,
              revision: next.revision,
              updatedAt: next.updatedAt,
              request: requestText(command),
              document: (await privacyDocument(command.language)).document,
            },
          },
        ]);
        return this.status(user, command.language);
      }
      if (
        (await this.state(user)) ||
        user.accountType !== 'adult' ||
        user.privacyMode ||
        command.expectedRevision !== 0
      )
        throw new ApiError('CONFLICT');
      const invite = (await mockGet<{ key: string; value: Invitation }>('kv', key))?.value;
      if (
        !invite ||
        invite.guardianId !== initial.value.guardianId ||
        invite.state !== 'authorized' ||
        !(invite.authorizationMethod === 'account_attestation'
          ? invite.attestation?.subjectId === invite.guardianId &&
            invite.attestation.emailVerified === true &&
            declaredNameValid(invite.attestation.declaredName) &&
            ['parent', 'legal_guardian'].includes(invite.attestation.relationship) &&
            Number.isSafeInteger(invite.attestation.authenticatedAt) &&
            invite.attestation.authenticatedAt >= invite.attestation.declaredAt - 15 * 60000 &&
            invite.attestation.authenticatedAt <= invite.attestation.declaredAt + 30000
          : (invite.authorizationMethod === undefined ||
              invite.authorizationMethod === 'operator_verified') &&
            !!invite.representationVerifiedAt &&
            !!invite.verificationCaseId) ||
        invite.recipientUsername !== user.username ||
        invite.guardianId === user.userId ||
        invite.expiresAt <= Date.now() ||
        !validAdolescentMajorityDate(invite.majorityAt) ||
        invite.documentHash !== (await privacyDocument(invite.language)).hash
      )
        throw new ApiError('FORBIDDEN');
      if (
        invite.authorizationMethod === 'account_attestation' &&
        !premiumCurrent(
          await mockGet<MockCoverageRow>('coverages', invite.guardianId),
          invite.guardianId,
        )
      )
        throw new ApiError('CAPABILITY_REQUIRED');
      for (const store of [
        'guardianLinks',
        'friendships',
        'friendRequests',
        'supervisionLinks',
        'seatAssignments',
        'coverages',
        'households',
      ] as const) {
        const rows = await mockGetAll<Record<string, unknown>>(store);
        if (
          rows.some((row) =>
            [
              'minorId',
              'guardianId',
              'adultId',
              'userA',
              'userB',
              'fromId',
              'toId',
              'accountId',
              'primaryResponsibleId',
            ].some((field) => row[field] === user.userId),
          )
        )
          throw new ApiError('CONFLICT');
      }
      const now = Date.now();
      const profile = {
        ...user,
        accountType: 'minor' as const,
        socialEnabled: false,
        privacyMode: 'adolescent_private' as const,
        majorityAt: invite.majorityAt,
      };
      const state: State = {
        ...(await this.status(user, command.language)),
        scope: 'adolescent_private',
        revision: 1,
        updatedAt: now,
        adolescentAcceptedAt: now,
        adolescentLanguage: command.language,
        adolescentHash: command.documentHash,
        invitationId: invite.invitationId,
        guardianId: invite.guardianId,
        guardianInstance: invite.guardianInstance,
        guardianConsent: 'granted',
        guardianLanguage: invite.language,
        guardianHash: invite.documentHash,
        guardianAuthorization: {
          method: invite.authorizationMethod ?? 'operator_verified',
          ...(invite.attestation ? { attestation: invite.attestation } : {}),
        },
        majorityAt: invite.majorityAt,
      };
      await this.parent(state);
      await mockPutPrivacyDecision(
        [
          { key: this.key(user), value: state },
          {
            key,
            value: {
              ...invite,
              state: 'accepted',
              revision: invite.revision + 1,
              adolescentId: user.userId,
            },
          },
          {
            key: evidenceKey,
            value: {
              action: command.action,
              revision: 1,
              updatedAt: now,
              request: requestText(command),
              documentHash: command.documentHash,
              document: (await privacyDocument(command.language)).document,
              verificationCaseId: invite.verificationCaseId,
              authentication: 'verified_mock_subject',
            },
          },
        ],
        undefined,
        profile,
      );
      return this.status(profile, command.language);
    });
  }
  async guardian(
    user: MockUserRow,
    adolescentId: string,
    command: PrivateAdolescentGuardianCommand,
  ): Promise<PrivacyStatus> {
    await this.validate(command, [
      'action',
      ...(command.action === 'grant_guardian' ? ['representsMinor', 'authorizesCloud'] : []),
    ]);
    if (
      !['grant_guardian', 'revoke_guardian'].includes(command.action) ||
      (command.action === 'grant_guardian' &&
        (this.adolescentMode !== 'enforce' ||
          command.representsMinor !== true ||
          command.authorizesCloud !== true))
    )
      throw new ApiError('VALIDATION');
    return withMockAccountLocks([user.userId, adolescentId], async () => {
      user = await this.active(user);
      const adolescent = await mockGet<MockUserRow>('users', adolescentId);
      if (!adolescent) throw new ApiError('NOT_FOUND');
      await this.active(adolescent);
      const old = await this.state(adolescent);
      if (
        !old ||
        !this.privateAdmission(adolescent, old) ||
        old.guardianId !== user.userId ||
        old.guardianInstance !== user.accountInstanceId
      )
        throw new ApiError('FORBIDDEN');
      await this.parent(old);
      const evidenceKey = `${this.key(adolescent)}:command:guardian:${command.commandId}`;
      const previous = await mockGet<{ key: string; value: { request: string } }>(
        'kv',
        evidenceKey,
      );
      if (previous) {
        if (previous.value.request !== requestText(command))
          throw new ApiError('PRIVACY_REVISION_CONFLICT');
        return this.status(adolescent, command.language);
      }
      if (old.revision !== command.expectedRevision || old.revision >= Number.MAX_SAFE_INTEGER)
        throw new ApiError('PRIVACY_REVISION_CONFLICT');
      const next = {
        ...old,
        revision: old.revision + 1,
        updatedAt: Date.now(),
        cloudConsent: 'revoked' as const,
        guardianConsent:
          command.action === 'grant_guardian' ? ('granted' as const) : ('revoked' as const),
        guardianHash: command.documentHash,
        guardianLanguage: command.language,
      };
      await mockPutPrivacyDecision([
        { key: this.key(adolescent), value: next },
        {
          key: evidenceKey,
          value: {
            action: command.action,
            actorId: user.userId,
            request: requestText(command),
            revision: next.revision,
            updatedAt: next.updatedAt,
            document: (await privacyDocument(command.language)).document,
          },
        },
      ]);
      return this.status(adolescent, command.language);
    });
  }
  async admit(user: MockUserRow): Promise<void> {
    if (this.mode === 'off') return;
    if (this.privateAdmission(user, await this.state(user))) return;
    if (user.accountType !== 'adult') throw new ApiError('FORBIDDEN');
    if (!(await this.status(user)).adultDeclared) throw new ApiError('ADULT_DECLARATION_REQUIRED');
  }
  async requireCloud(user: MockUserRow): Promise<State | undefined> {
    const state = await this.state(user);
    if (this.mode === 'off' && !state) return undefined;
    const current = await this.status(user);
    if (current.scope === 'unsupported') throw new ApiError('FORBIDDEN');
    if (current.scope === 'adult' && !current.adultDeclared)
      throw new ApiError('ADULT_DECLARATION_REQUIRED');
    if (!['none', 'completed'].includes(current.erasure))
      throw new ApiError('PRIVACY_ERASURE_PENDING');
    if (
      current.scope === 'adolescent_private' &&
      current.guardianConsent === 'granted' &&
      current.cloudConsent === 'granted' &&
      current.cloudCoverage?.state !== 'active'
    )
      throw new ApiError('CAPABILITY_REQUIRED');
    if (!current.canUseCloud) throw new ApiError('CLOUD_CONSENT_REQUIRED');
    return state?.guardianId && current.scope === 'adolescent_private'
      ? { ...state, guardianRevision: (await this.parent(state)).privacy.revision }
      : state;
  }
  async verifyCloud(
    user: MockUserRow,
    expected: State | undefined,
    rows: readonly MockRecordRow[] = [],
  ): Promise<void> {
    if (!expected) return;
    const latest = await this.requireCloud(user);
    if (
      latest?.revision !== expected.revision ||
      latest?.guardianRevision !== expected.guardianRevision
    )
      throw new ApiError('CLOUD_CONSENT_REQUIRED');
    if (
      rows.some(
        (row) =>
          row.ownerId !== user.userId ||
          (expected.erasedRevision &&
            (!row.privacyRevision || row.privacyRevision <= expected.erasedRevision)),
      )
    )
      throw new ApiError('PRIVACY_ERASURE_PENDING');
  }
  async export(user: MockUserRow, cursor?: string): Promise<PrivacyExportPage> {
    if (cursor !== undefined) throw new ApiError('VALIDATION');
    const state = await this.state(user);
    const records = (await mockGetAll<MockRecordRow>('records')).filter(
      (row) =>
        row.ownerId === user.userId &&
        (!state?.erasedRevision || (row.privacyRevision ?? 0) > state.erasedRevision),
    );
    const evidence = (await mockGetAll<{ key: string; value: Record<string, unknown> }>('kv'))
      .filter((row) => row.key.startsWith(`${this.key(user)}:command:`))
      .map((row) => {
        const { request: _request, ...minimum } = row.value;
        return minimum;
      });
    return {
      formatVersion: 1,
      userId: user.userId,
      exportedAt: Date.now(),
      account: {
        username: user.username,
        displayName: user.displayName,
        ...(user.email ? { email: user.email } : {}),
        createdAt: user.createdAt,
      },
      records: records.map((row) => ({ store: row.store, record: row.record })),
      privacy: evidence,
      cursor: null,
    };
  }
}
