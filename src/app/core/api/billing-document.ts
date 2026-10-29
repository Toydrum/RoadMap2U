import { subscriptionTermsDocument } from './subscription-terms-documents';
/** Exact immutable recurring consent text shown to this buyer. */
export async function billingDocument(language: 'es' | 'en') {
  if (language !== 'es' && language !== 'en') throw new TypeError('invalid billing language');
  return subscriptionTermsDocument(language);
}
