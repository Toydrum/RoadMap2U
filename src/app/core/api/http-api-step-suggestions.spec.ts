import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthProvider } from '../auth/auth-provider';
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
    const payload = { suggestions: ['Elegir semillas', 'Llenar la maceta', 'Humedecer la tierra'] };
    const fetch = vi.fn(async () => Response.json(payload));
    vi.stubGlobal('fetch', fetch);

    expect(await api.suggestSteps(context)).toEqual(payload);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/v1/ai/step-suggestions', {
      method: 'POST',
      headers: { authorization: 'Bearer pilot-token', 'content-type': 'application/json' },
      body: JSON.stringify(context),
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
});
