import { describe, expect, it } from 'vitest';

describe('browser-like unit test environment', () => {
  it('uses the jsdom localStorage implementation', () => {
    const nodeOptions = (
      Reflect.get(globalThis, 'process') as { env?: Record<string, string | undefined> }
    ).env?.['NODE_OPTIONS'];

    expect(nodeOptions).toContain('--no-experimental-webstorage');
    expect(localStorage).toBe(window.localStorage);

    localStorage.setItem('roadmap2u-storage-probe', 'ok');
    expect(window.localStorage.getItem('roadmap2u-storage-probe')).toBe('ok');
    localStorage.removeItem('roadmap2u-storage-probe');
  });
});
