import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthProvider } from '../auth/auth-provider';
import { APP_CONFIG } from '../config';
import { HttpApi } from './http-api';

const context = {
  language: 'es' as const,
  treeTitle: 'Preparar el balcón',
  branchTitle: 'Sembrar albahaca',
  ancestorTitles: ['Elegir plantas'],
  existingStepTitles: ['Enjuagar la maceta'],
};

afterEach(() => vi.unstubAllGlobals());

describe('step suggestions HTTP transport', () => {
  const api = new HttpApi({
    idToken: async () => 'pilot-token',
  } as unknown as AuthProvider);

  it('sends only the approved context in an authenticated POST', async () => {
    const request = { ...context, maxSuggestions: 1 as const };
    const payload = { suggestions: ['Elegir semillas'] };
    const fetch = vi.fn(async () => Response.json(payload));
    vi.stubGlobal('fetch', fetch);

    expect(await api.suggestSteps(request)).toEqual(payload);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${APP_CONFIG.aws.apiBaseUrl}/v1/ai/step-suggestions`, {
      method: 'POST',
      headers: { authorization: 'Bearer pilot-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
  });

  it('does not replay generation after a server failure', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: { code: 'STEP_SUGGESTIONS_UNAVAILABLE' } }, { status: 503 }),
    );
    vi.stubGlobal('fetch', fetch);

    await expect(api.suggestSteps(context)).rejects.toMatchObject({
      code: 'STEP_SUGGESTIONS_UNAVAILABLE',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves the clarification field and waits for the caller to provide more context', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: { code: 'STEP_SUGGESTIONS_CONTEXT_REQUIRED', message: 'destination' } }, { status: 400 }),
    );
    vi.stubGlobal('fetch', fetch);

    await expect(api.suggestSteps({ ...context, maxSuggestions: 1 })).rejects.toMatchObject({
      code: 'STEP_SUGGESTIONS_CONTEXT_REQUIRED', message: 'destination',
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
