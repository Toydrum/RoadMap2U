import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function loadPrivacyDocuments() {
  // Execute only our bundled, framework-free dictionary/contract definitions.
  // This is the same document function used by the app and canonical server.
  const bundled = await build({
    stdin: {
      resolveDir: root,
      loader: 'ts',
      contents: `
    import { adultPrivacyDocument } from './src/app/core/api/contracts';
    import { ES } from './src/app/core/i18n/es';
    import { EN } from './src/app/core/i18n/en';
    export const documents = { es: adultPrivacyDocument('es', ES), en: adultPrivacyDocument('en', EN) };
  `,
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const module = { exports: {} };
  runInNewContext(
    bundled.outputFiles[0].text,
    { module, exports: module.exports },
    { timeout: 1000 },
  );
  return module.exports.documents;
}
export async function currentPrivacyDocuments() {
  const documents = await loadPrivacyDocuments();
  return {
    versions: {
      privacy: documents.es.versions.noticeVersion,
      terms: documents.es.versions.termsVersion,
      cloudConsent: documents.es.versions.cloudConsentVersion,
    },
    hashes: Object.fromEntries(
      Object.entries(documents).map(([lang, document]) => [
        lang,
        createHash('sha256').update(JSON.stringify(document)).digest('hex'),
      ]),
    ),
  };
}
export function validateIndividualPublication(
  manifest,
  { stage, scope = 'adult_private_adolescents', versions, hashes } = {},
) {
  const failures = [];
  if (!['dev', 'test', 'prod'].includes(stage)) failures.push('invalid_stage');
  if (!['adult', 'adult_private_adolescents'].includes(scope)) failures.push('invalid_scope');
  if (!manifest || manifest.schemaVersion !== 1)
    return { valid: false, failures: [...failures, 'invalid_manifest'] };
  if (
    versions &&
    Object.entries(versions).some(([key, value]) => manifest.versions?.[key] !== value)
  )
    failures.push('version_mismatch');
  if (stage === 'prod') {
    for (const key of [
      'productionPublicationApproved',
      'adultPublicationApproved',
      'consentImplementedAndVerified',
      'retentionImplementedAndReconciled',
      'rightsProcedureRehearsed',
      'providerContractsReviewed',
    ]) {
      if (manifest[key] !== true) failures.push(key);
    }
    if (
      scope === 'adult_private_adolescents' &&
      manifest.privateAdolescentPublicationApproved !== true
    )
      failures.push('privateAdolescentPublicationApproved');
    if (manifest.status !== 'approved_for_publication') failures.push('unapproved_status');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.effectiveDate ?? ''))
      failures.push('missing_effective_date');
    if (
      !manifest.legalController?.name?.trim() ||
      !manifest.legalController?.noticeAddress?.trim() ||
      !manifest.legalController?.noticeAddressPublicUseAuthorizedByOwnerOn
    )
      failures.push('incomplete_controller');
    for (const key of ['privacy', 'support'])
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(manifest.publicContacts?.[key] ?? ''))
        failures.push(`contact_${key}`);
    const approval = manifest.publicationApproval;
    if (
      approval?.basis !== 'responsible_owner' ||
      approval?.approvedBy !== manifest.legalController?.name ||
      !approval?.approvedBy?.trim() ||
      !/^\d{4}-\d{2}-\d{2}$/.test(approval?.approvedOn ?? '')
    )
      failures.push('missing_owner_approval');
    if (
      !hashes ||
      ['es', 'en'].some(
        (lang) => !hashes[lang] || approval?.documentHashes?.[lang] !== hashes[lang],
      )
    )
      failures.push('approved_document_mismatch');
    if (Object.values(manifest.versions ?? {}).some((value) => /draft/i.test(value)))
      failures.push('draft_versions');
    if (!Array.isArray(manifest.remainingGates) || manifest.remainingGates.length)
      failures.push('unresolved_gates');
    if (manifest.implementationLocalOnly !== false) failures.push('local_validation_only');
  }
  return { valid: failures.length === 0, failures };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--stage') throw new Error('Use --stage dev|test|prod');
    const documents = await currentPrivacyDocuments();
    const manifest = JSON.parse(
      await readFile(
        resolve(root, 'docs/legal-drafts/individual-publication-readiness.json'),
        'utf8',
      ),
    );
    const result = validateIndividualPublication(manifest, { stage: args[1], ...documents });
    if (!result.valid) throw new Error(`Publication blocked: ${result.failures.join(', ')}`);
    process.stdout.write(
      `Privacy publication gate: ${args[1]} ${args[1] === 'prod' ? 'approved' : 'draft validation'}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
