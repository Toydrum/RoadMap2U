import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpApi } from './http-api';
import type { AuthProvider } from '../auth/auth-provider';
import { ADULT_PRIVACY_VERSIONS, ApiError, type PrivacyConsentCommand } from './contracts';
const command: PrivacyConsentCommand = {
  ...ADULT_PRIVACY_VERSIONS,
  action: 'grant_cloud',
  accepted: true,
  expectedRevision: 7,
  language: 'es',
  commandId: 'fixed-command-id',
  documentHash: 'a'.repeat(64),
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('privacy HTTP transport', () => {
  it('retries an ambiguous server failure with exactly the same authenticated consent command', async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ revision: 8 }), { status: 200 }));
    vi.stubGlobal('fetch', request);
    const api = new HttpApi({
      idToken: async () => 'verified-owner-token',
    } as unknown as AuthProvider);
    const pending = api.changePrivacyConsent(command);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ revision: 8 });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][1].body).toBe(JSON.stringify(command));
    expect(request.mock.calls[1][1]).toEqual(request.mock.calls[0][1]);
    expect(request.mock.calls[0][1].headers.authorization).toBe('Bearer verified-owner-token');
  });
  it('exposes a revision conflict without replaying or substituting another actor/revision', async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'PRIVACY_REVISION_CONFLICT' } }), {
          status: 409,
        }),
    );
    vi.stubGlobal('fetch', request);
    const api = new HttpApi({
      idToken: async () => 'verified-owner-token',
    } as unknown as AuthProvider);
    await expect(api.changePrivacyConsent(command)).rejects.toBeInstanceOf(ApiError);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
