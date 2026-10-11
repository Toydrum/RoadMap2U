import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  currentPrivacyDocuments,
  validateIndividualPublication,
} from './validate-individual-publication.mjs';

const versions = { privacy: 'privacy-v1', terms: 'terms-v1', cloudConsent: 'cloud-v1' };
const hashes = { es: 'a'.repeat(64), en: 'b'.repeat(64) };
const approved = () => ({
  schemaVersion: 1,
  status: 'approved_for_publication',
  effectiveDate: '2026-10-07',
  versions,
  legalController: {
    name: 'Héctor Coronado',
    noticeAddress: 'Confirmed notification address',
    noticeAddressPublicUseAuthorizedByOwnerOn: '2026-10-07',
  },
  publicContacts: { privacy: 'overseer@roadmap2u.com', support: 'overseer@roadmap2u.com' },
  publicationApproval: {
    basis: 'responsible_owner',
    approvedBy: 'Héctor Coronado',
    approvedOn: '2026-10-07',
    externalLegalReviewRequired: false,
    documentHashes: hashes,
  },
  remainingGates: [],
  implementationLocalOnly: false,
  productionPublicationApproved: true,
  adultPublicationApproved: true,
  privateAdolescentPublicationApproved: true,
  consentImplementedAndVerified: true,
  retentionImplementedAndReconciled: true,
  rightsProcedureRehearsed: true,
  providerContractsReviewed: true,
});
test('permits an owner-approved and environment-validated release with the same ES/EN document hashes', () => {
  assert.equal(
    validateIndividualPublication(approved(), { stage: 'prod', versions, hashes }).valid,
    true,
  );
});
test('permits the responsible owner to approve exact texts without an external lawyer review', () => {
  const manifest = {
    ...approved(),
    legalReview: null,
    publicationApproval: {
      approvedBy: 'Héctor Coronado',
      approvedOn: '2026-10-07',
      basis: 'responsible_owner',
      externalLegalReviewRequired: false,
      documentHashes: hashes,
    },
  };
  assert.equal(
    validateIndividualPublication(manifest, { stage: 'prod', versions, hashes }).valid,
    true,
  );
});
for (const key of [
  'productionPublicationApproved',
  'adultPublicationApproved',
  'privateAdolescentPublicationApproved',
  'consentImplementedAndVerified',
  'retentionImplementedAndReconciled',
  'rightsProcedureRehearsed',
  'providerContractsReviewed',
]) {
  test(`keeps PROD closed without ${key}`, () => {
    assert.equal(
      validateIndividualPublication(
        { ...approved(), [key]: false },
        { stage: 'prod', versions, hashes },
      ).valid,
      false,
    );
  });
}
test('does not reuse owner approval after either translated document changes', () => {
  assert.equal(
    validateIndividualPublication(approved(), {
      stage: 'prod',
      versions,
      hashes: { ...hashes, en: 'c'.repeat(64) },
    }).valid,
    false,
  );
});
test('does not permit drafts, missing owner approval or unresolved gates', () => {
  for (const override of [
    { versions: { ...versions, privacy: 'draft1' } },
    { publicationApproval: null },
    { publicationApproval: { ...approved().publicationApproval, approvedBy: 'Someone else' } },
    { remainingGates: ['provider_review'] },
    { implementationLocalOnly: true },
  ]) {
    assert.equal(
      validateIndividualPublication(
        { ...approved(), ...override },
        { stage: 'prod', versions, hashes },
      ).valid,
      false,
    );
  }
});
test('external legal review alone does not replace the responsible owner approval', () => {
  assert.equal(
    validateIndividualPublication(
      {
        ...approved(),
        publicationApproval: null,
        legalReview: {
          reviewedBy: 'External reviewer',
          reviewedOn: '2026-10-07',
          documentHashes: hashes,
        },
      },
      { stage: 'prod', versions, hashes },
    ).valid,
    false,
  );
});
test('validates the owner-approved current sources and exact ES/EN hashes in DEV/TEST/PROD', async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL('../docs/legal-drafts/individual-publication-readiness.json', import.meta.url),
      'utf8',
    ),
  );
  const current = await currentPrivacyDocuments();
  for (const stage of ['dev', 'test', 'prod'])
    assert.equal(validateIndividualPublication(manifest, { stage, ...current }).valid, true);
  assert.deepEqual(manifest.publicationApproval.documentHashes, current.hashes);
  assert.equal(manifest.paymentActivationApproved, false);
  assert.equal(manifest.familyActivationApproved, false);
  assert.equal(
    manifest.privateAdolescentAuthorization.verifiesCivilIdentityOrParentageDocuments,
    false,
  );
  assert.equal(
    manifest.privateAdolescentAuthorization.requiresManualOperatorForRoutineSignup,
    false,
  );
  assert.notEqual(current.hashes.es, current.hashes.en);
});
