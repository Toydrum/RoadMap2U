/** Hash the exact full recurring consent text shown to this buyer. */
export async function billingDocument(language: 'es' | 'en') {
  if (language !== 'es' && language !== 'en') throw new TypeError('invalid billing language');
  const dictionary =
    language === 'es' ? (await import('../i18n/es')).ES : (await import('../i18n/en')).EN;
  const text = dictionary.billing.termsText;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return { language, version: dictionary.billing.termsVersion, hash, text };
}
