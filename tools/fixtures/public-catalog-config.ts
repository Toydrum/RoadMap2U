/** Build-only fixture. Public catalog requests can target loopback only. */
const loopback = globalThis.location?.hostname === 'localhost' ||
  globalThis.location?.hostname === '127.0.0.1';

export const DEPLOY_STAGE = 'local' as const;
export const BACKEND_CONTRACT_SHA256 = 'browser-catalog-fixture';
export const GENERATED_APP_CONFIG = Object.freeze({
  backend: 'aws' as 'mock' | 'aws',
  requireAuth: false,
  aws: Object.freeze({
    region: '',
    userPoolId: '',
    userPoolClientId: '',
    apiBaseUrl: loopback ? globalThis.location.origin : 'http://127.0.0.1:1',
  }),
});
