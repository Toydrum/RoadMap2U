import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthProvider } from '../auth/auth-provider';
import { APP_CONFIG } from '../config';
import * as Contracts from './contracts';
import { PREPAYMENT_PLAN_CATALOG } from './contracts';
import type {
  AccessSource,
  ApplySubscriptionChangeRequest,
  BillingSummary,
  CreateCheckoutRequest,
  CreatePortalRequest,
  HouseholdView,
  MinorFriendRequestView,
  PreviewSubscriptionChangeRequest,
} from './contracts';
import { HttpApi } from './http-api';

const EXPECTED_OFFERS = [
  {
    offerKey: 'premium_individual',
    planKey: 'premium',
    minorSeats: 0,
    additionalResponsibleSeat: 0,
    prices: {
      month: { amountMinor: 9_900 },
      year: { amountMinor: 94_900 },
    },
  },
  {
    offerKey: 'family_1_minor',
    planKey: 'premium',
    minorSeats: 1,
    additionalResponsibleSeat: 0,
    prices: {
      month: { amountMinor: 14_900 },
      year: { amountMinor: 142_900 },
    },
  },
  {
    offerKey: 'family_2_minors',
    planKey: 'premium',
    minorSeats: 2,
    additionalResponsibleSeat: 0,
    prices: {
      month: { amountMinor: 18_900 },
      year: { amountMinor: 180_900 },
    },
  },
  {
    offerKey: 'family_1_minor_1_additional_responsible',
    planKey: 'premium',
    minorSeats: 1,
    additionalResponsibleSeat: 1,
    prices: {
      month: { amountMinor: 19_900 },
      year: { amountMinor: 190_900 },
    },
  },
  {
    offerKey: 'family_2_minors_1_additional_responsible',
    planKey: 'premium',
    minorSeats: 2,
    additionalResponsibleSeat: 1,
    prices: {
      month: { amountMinor: 23_900 },
      year: { amountMinor: 228_900 },
    },
  },
] as const;

type LooseApi = Record<string, (...args: unknown[]) => Promise<unknown>>;

function captureHttpApi(): {
  api: LooseApi;
  calls: () => Array<{ method: string; path: string; body: unknown }>;
} {
  const auth = { idToken: vi.fn(async () => 'token') } as unknown as AuthProvider;
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return {
    api: new HttpApi(auth) as unknown as LooseApi,
    calls: () =>
      fetchMock.mock.calls.map(([url, init]) => {
        const request = init as RequestInit;
        return {
          method: request.method ?? 'GET',
          path: String(url).slice(`${APP_CONFIG.aws.apiBaseUrl}/v1`.length),
          body: request.body ? JSON.parse(String(request.body)) : undefined,
        };
      }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('family and billing contract', () => {
  it('publishes the five approved offers with exact seat capacities and MXN prices', () => {
    const catalog = PREPAYMENT_PLAN_CATALOG as unknown as {
      version: string;
      pricingVersion: string;
      currency: string;
      taxInclusive: boolean;
      offers?: unknown;
    };

    expect(catalog).toMatchObject({
      version: '2026-09-family-v1',
      pricingVersion: 'family-launch-2026',
      currency: 'MXN',
      taxInclusive: true,
    });
    expect(catalog.offers).toEqual(EXPECTED_OFFERS);
  });

  it('publishes closed vocabularies for family, social, coverage, and billing state', () => {
    const contracts = Contracts as unknown as Record<string, unknown>;

    expect(contracts['ACCOUNT_STATES']).toEqual([
      'minor_supervised',
      'adult_transition_pending',
      'adult_self_managed',
    ]);
    expect(contracts['HOUSEHOLD_STATES']).toEqual([
      'active',
      'disputed',
      'legacy_over_capacity',
      'closed',
    ]);
    expect(contracts['SUPERVISION_ROLES']).toEqual([
      'primary_responsible',
      'additional_responsible',
    ]);
    expect(contracts['SEAT_TYPES']).toEqual(['minor', 'additional_responsible']);
    expect(contracts['COVERAGE_STATES']).toEqual(['active', 'grace', 'scheduled_end', 'ended']);
    expect(contracts['FRIENDSHIP_CLASSES']).toEqual(['adult_adult', 'minor_minor']);
    expect(contracts['CONSENT_KINDS']).toEqual([
      'requester_action',
      'requester_responsible_approval',
      'recipient_acceptance',
      'recipient_responsible_approval',
    ]);
    expect(contracts['BILLING_STATES']).toEqual([
      'none',
      'checkout_pending',
      'active',
      'cancel_at_period_end',
      'past_due_grace',
      'scheduled_change',
      'expired',
      'payment_review',
    ]);
  });

  it('versions family DTOs and exposes every minimum domain error', () => {
    const contracts = Contracts as unknown as Record<string, unknown>;
    const serverCodes = new Set(Contracts.SERVER_API_ERROR_CODES);

    expect(contracts['FAMILY_BILLING_CONTRACT_VERSION']).toBe(1);
    expect([...serverCodes]).toEqual(
      expect.arrayContaining([
        'ADULT_MINOR_FRIENDSHIP_FORBIDDEN',
        'ACCOUNT_TYPE_INCOMPATIBLE',
        'RESPONSIBLE_SCOPE_REQUIRED',
        'CONSENT_INCOMPLETE',
        'MINOR_ALREADY_COVERED',
        'HOUSEHOLD_CAPACITY_EXCEEDED',
        'CURRENT_PRIMARY_APPROVAL_REQUIRED',
        'LEGAL_REGION_UNSUPPORTED',
        'OFFER_NOT_ALLOWED',
        'CHECKOUT_IN_PROGRESS',
        'SUBSCRIPTION_CONFLICT',
        'PAYMENT_REQUIRED',
        'REAUTHENTICATION_REQUIRED',
        'STALE_REVISION',
      ]),
    );
  });

  it('types household, minor friendship, access, and billing DTOs without provider IDs', () => {
    const primary = {
      userId: 'adult-a',
      username: 'adult_a',
      displayName: 'Adult A',
      accountType: 'adult',
    } as const;
    const minor = {
      userId: 'minor-a',
      username: 'minor_a',
      displayName: 'Minor A',
      accountType: 'minor',
      socialEnabled: true,
    } as const;
    const household = {
      contractVersion: 1,
      householdId: 'household-a',
      country: 'MX',
      state: 'active',
      myRole: 'primary_responsible',
      primaryResponsible: primary,
      additionalResponsible: null,
      minors: [
        {
          user: minor,
          seat: 1,
          majorityAt: '2032-06-15',
          coverageState: 'active',
        },
      ],
      availableMinorSeats: 1,
      additionalResponsibleSeatAvailable: true,
      revision: 3,
    } satisfies HouseholdView;
    const friendRequest = {
      contractVersion: 1,
      requestId: 'request-a-b',
      friendshipClass: 'minor_minor',
      state: 'pending',
      requester: minor,
      recipient: { ...minor, userId: 'minor-b', username: 'minor_b' },
      consents: [
        { kind: 'requester_action', recordedAt: 1 },
        { kind: 'requester_responsible_approval', recordedAt: 2 },
      ],
      expiresAt: 100,
      revision: 2,
    } satisfies MinorFriendRequestView;
    const accessSource = {
      kind: 'subscription',
      sourceId: 'coverage-a',
      planKey: 'premium',
      validUntil: 200,
      scope: 'family_member',
      householdId: household.householdId,
      seatType: 'minor',
    } satisfies AccessSource;
    const primarySource = {
      ...accessSource,
      seatType: 'primary_responsible',
    } satisfies AccessSource;
    expect(primarySource.seatType).toBe('primary_responsible');
    const billing = {
      contractVersion: 1,
      availability: 'available',
      householdId: household.householdId,
      payerAccountId: primary.userId,
      state: 'active',
      currentOfferKey: 'family_1_minor',
      interval: 'month',
      paidThrough: 200,
      graceUntil: null,
      cancelAtPeriodEnd: false,
      pendingChange: null,
      revision: 4,
    } satisfies BillingSummary;
    const command = {
      householdId: household.householdId,
      offerKey: 'family_2_minors',
      interval: 'year',
      expectedHouseholdRevision: household.revision,
      commandId: '00000000-0000-4000-8000-000000000001',
    } satisfies CreateCheckoutRequest &
      PreviewSubscriptionChangeRequest &
      ApplySubscriptionChangeRequest;
    const portal = {
      householdId: household.householdId,
      expectedHouseholdRevision: household.revision,
      commandId: '00000000-0000-4000-8000-000000000002',
    } satisfies CreatePortalRequest;

    expect({ household, friendRequest, accessSource, billing, command, portal }).not.toHaveProperty(
      'priceId',
    );
    expect(accessSource.scope).toBe('family_member');
  });

  it('publishes exact additive family, social, and billing paths', () => {
    const paths = Contracts.API_PATHS as unknown as Record<string, unknown>;
    const path = (name: string, ...parts: string[]): string =>
      (paths[name] as (...values: string[]) => string)(...parts);

    expect(paths).toMatchObject({
      familyHousehold: '/family/household',
      familyMinors: '/family/minors',
      familyMinorLinkRequests: '/family/minor-link-requests',
      familyAdditionalResponsibleInvitations: '/family/additional-responsible-invitations',
      familyAdditionalResponsibleScope: '/family/additional-responsible/scope',
      familyAdditionalResponsible: '/family/additional-responsible',
      familyTransferPrimaryResponsibility: '/family/transfer-primary-responsibility',
      socialAdultFriendRequests: '/social/adult-friend-requests',
      socialMinorInviteCodes: '/social/minor-invite-codes',
      socialMinorFriendRequests: '/social/minor-friend-requests',
      billingSummary: '/billing/summary',
      billingCheckout: '/billing/checkout',
      billingChangePreview: '/billing/change-preview',
      billingChange: '/billing/change',
      billingPortal: '/billing/portal',
    });
    expect(path('familyMinorLinkRequestApprove', 'link-1')).toBe(
      '/family/minor-link-requests/link-1/approve',
    );
    expect(path('familyMinorLinkRequestAccept', 'link-1')).toBe(
      '/family/minor-link-requests/link-1/accept',
    );
    expect(path('familyAdditionalResponsibleInvitationAccept', 'invite-1')).toBe(
      '/family/additional-responsible-invitations/invite-1/accept',
    );
    expect(path('socialAdultFriendRequestAccept', 'adult-request-1')).toBe(
      '/social/adult-friend-requests/adult-request-1/accept',
    );
    expect(path('socialFriendship', 'friendship-1')).toBe('/social/friendships/friendship-1');
    expect(path('socialMinorFriendRequestAccept', 'minor-request-1')).toBe(
      '/social/minor-friend-requests/minor-request-1/minor-accept',
    );
    expect(path('socialMinorFriendRequestResponsibleApprove', 'minor-request-1')).toBe(
      '/social/minor-friend-requests/minor-request-1/responsible-approve',
    );
    expect(path('socialMinorFriendRequestReject', 'minor-request-1')).toBe(
      '/social/minor-friend-requests/minor-request-1/reject',
    );
    expect(path('socialMinorFriendship', 'friendship-1')).toBe(
      '/social/minor-friendships/friendship-1',
    );
  });

  it('routes the additive family surface through the authenticated HTTP seam', async () => {
    const { api, calls } = captureHttpApi();
    const command = {
      householdId: 'household-a',
      expectedHouseholdRevision: 3,
      commandId: '00000000-0000-4000-8000-000000000003',
      policyVersion: 'family-mx-v1',
    };

    await api['getHousehold']();
    await api['createMinor']({ ...command, username: 'minor_a' });
    await api['createMinorLinkRequest']({ ...command, code: 'opaque-code' });
    await api['approveMinorLinkRequest']('link-1', command);
    await api['acceptMinorLinkRequest']('link-1', {
      ...command,
      responsibilityVersion: 'minor-link-responsibility-v1',
      privacyVersion: 'minor-link-privacy-v1',
    });
    await api['createAdditionalResponsibleInvitation']({
      ...command,
      intendedAdultId: 'adult-b',
      minorIds: ['minor-a'],
    });
    await api['acceptAdditionalResponsibleInvitation']('invite-1', command);
    await api['replaceAdditionalResponsibleScope']({ ...command, minorIds: ['minor-a'] });
    await api['revokeAdditionalResponsible'](command);
    await api['transferPrimaryResponsibility']({
      ...command,
      newPrimaryAccountId: 'adult-b',
    });

    expect(calls()).toEqual([
      { method: 'GET', path: '/family/household', body: undefined },
      { method: 'POST', path: '/family/minors', body: { ...command, username: 'minor_a' } },
      {
        method: 'POST',
        path: '/family/minor-link-requests',
        body: { ...command, code: 'opaque-code' },
      },
      {
        method: 'POST',
        path: '/family/minor-link-requests/link-1/approve',
        body: command,
      },
      {
        method: 'POST',
        path: '/family/minor-link-requests/link-1/accept',
        body: {
          ...command,
          responsibilityVersion: 'minor-link-responsibility-v1',
          privacyVersion: 'minor-link-privacy-v1',
        },
      },
      {
        method: 'POST',
        path: '/family/additional-responsible-invitations',
        body: { ...command, intendedAdultId: 'adult-b', minorIds: ['minor-a'] },
      },
      {
        method: 'POST',
        path: '/family/additional-responsible-invitations/invite-1/accept',
        body: command,
      },
      {
        method: 'PUT',
        path: '/family/additional-responsible/scope',
        body: { ...command, minorIds: ['minor-a'] },
      },
      { method: 'DELETE', path: '/family/additional-responsible', body: command },
      {
        method: 'POST',
        path: '/family/transfer-primary-responsibility',
        body: { ...command, newPrimaryAccountId: 'adult-b' },
      },
    ]);
  });

  it('routes adult and minor friendships without legacy family traversal', async () => {
    const { api, calls } = captureHttpApi();
    const action = {
      minorId: 'minor-a',
      commandId: '00000000-0000-4000-8000-000000000004',
      policyVersion: 'minor-social-v1',
    };

    await api['createAdultFriendRequest']({ code: 'adult-code' });
    await api['acceptAdultFriendRequest']('adult-request-1');
    await api['removeSocialFriendship']('adult-friendship-1');
    await api['createMinorInviteCode']({ minorId: 'minor-a' });
    await api['createMinorFriendRequest']({ minorId: 'minor-a', code: 'minor-code' });
    await api['acceptMinorFriendRequest']('minor-request-1', action);
    await api['approveMinorFriendRequest']('minor-request-1', action);
    await api['rejectMinorFriendRequest']('minor-request-1', action);
    await api['removeMinorFriendship']('minor-friendship-1');

    expect(calls()).toEqual([
      { method: 'POST', path: '/social/adult-friend-requests', body: { code: 'adult-code' } },
      {
        method: 'POST',
        path: '/social/adult-friend-requests/adult-request-1/accept',
        body: undefined,
      },
      {
        method: 'DELETE',
        path: '/social/friendships/adult-friendship-1',
        body: undefined,
      },
      { method: 'POST', path: '/social/minor-invite-codes', body: { minorId: 'minor-a' } },
      {
        method: 'POST',
        path: '/social/minor-friend-requests',
        body: { minorId: 'minor-a', code: 'minor-code' },
      },
      {
        method: 'POST',
        path: '/social/minor-friend-requests/minor-request-1/minor-accept',
        body: action,
      },
      {
        method: 'POST',
        path: '/social/minor-friend-requests/minor-request-1/responsible-approve',
        body: action,
      },
      {
        method: 'POST',
        path: '/social/minor-friend-requests/minor-request-1/reject',
        body: action,
      },
      {
        method: 'DELETE',
        path: '/social/minor-friendships/minor-friendship-1',
        body: undefined,
      },
    ]);
  });

  it('routes billing commands without accepting amount, quantity, or provider IDs', async () => {
    const { api, calls } = captureHttpApi();
    const command = {
      householdId: 'household-a',
      offerKey: 'family_1_minor',
      interval: 'month',
      expectedHouseholdRevision: 3,
      commandId: '00000000-0000-4000-8000-000000000005',
    };
    const portal = {
      householdId: command.householdId,
      expectedHouseholdRevision: command.expectedHouseholdRevision,
      commandId: '00000000-0000-4000-8000-000000000006',
    };

    await api['getBillingSummary']();
    await api['createCheckout'](command);
    await api['previewSubscriptionChange'](command);
    await api['applySubscriptionChange'](command);
    await api['createPortalSession'](portal);

    expect(calls()).toEqual([
      { method: 'GET', path: '/billing/summary', body: undefined },
      { method: 'POST', path: '/billing/checkout', body: command },
      { method: 'POST', path: '/billing/change-preview', body: command },
      { method: 'POST', path: '/billing/change', body: command },
      { method: 'POST', path: '/billing/portal', body: portal },
    ]);
    expect(JSON.stringify(calls())).not.toMatch(/amount|quantity|priceId|customerId/);
  });
});
