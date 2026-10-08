import { adultPrivacyDocument } from './contracts';
/** Loaded on demand; English and the account flow do not wake the product graph. */
export async function privacyDocument(language: 'es' | 'en') {
  if (language !== 'es' && language !== 'en') throw new TypeError('invalid privacy language');
  const dictionary =
    language === 'es' ? (await import('../i18n/es')).ES : (await import('../i18n/en')).EN;
  const document = adultPrivacyDocument(language, dictionary);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(document)),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return { document, hash };
}

export function privacyCalendarDate(now = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)!.value)
    .join('-');
}
export function validAdolescentMajorityDate(value: string, now = Date.now()): boolean {
  const today = privacyCalendarDate(now);
  const date = new Date(`${value}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    value > today &&
    value <= `${Number(today.slice(0, 4)) + 6}${today.slice(4)}`
  );
}
