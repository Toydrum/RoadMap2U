# Common account launch: Free and individual Premium

Status: **Pending owner design approval.** This document authorizes no implementation, deployment, AWS action, or access-code operation.

## Resumen para aprobar

El registro común permitirá usar Free o comprar Premium individual sin elegir edad ni declarar mayoría de edad. Se conservarán correo confirmado, contraseña y aceptación de términos; Premium requerirá pago confirmado y aceptación expresa de los cobros recurrentes. La nube seguirá siendo una autorización separada y voluntaria. Las cuentas privadas o supervisadas existentes conservarán su modalidad y sus datos, sin conversión automática. Este documento propone cambios locales y pruebas: no cambia PROD ni autoriza operaciones reales de pagos o llaves. La modificación de contratos y términos queda pendiente de aprobación.

## Outcome and boundary

For this first launch, a new person can create a standard own-account with username, email, password and affirmative terms acceptance, confirm their email, and use Free or choose to buy individual Premium. Signup and purchase ask for no age choice, adult declaration, guardian invitation or adolescent-understanding checkbox. Signup does not grant Premium or cloud consent. The technical `adult | minor` account vocabulary remains for compatibility; a standard self-signup's technical `adult` value must never be presented or recorded as a declaration of adulthood.

Existing paid periods, sponsored grants, account instances, local forests, privacy evidence and Portal/cancellation access remain intact. Existing known private-adolescent and guardian-created minor accounts retain their restrictions, guardian links, recovery model and consent history. They are **outside this migration** and are not converted to standard accounts. Owner approval must acknowledge this exception to a universal identical flow; enabling personal purchases for that historical cohort requires a separate design for its currently Free-only access and guardian-backed cloud model.

## Recommended design and alternatives

Use a terms-only standard-account admission alongside historical adult/private admission. Reuse the current privacy API, evidence rows, idempotent command handling, billing services and stores; add no infrastructure or stores.

Removing only the checkboxes is insufficient: `afterAuth`, PrivacyPanel, mock admission, checkout persistence conditions and the checkout worker still require adult admission. Reinstating guardian signup preserves the old model but does not deliver the requested standard Free/Premium signup.

## Admission, documents and compatibility

Extend `POST /privacy/consents` with `accept_account_terms`, carrying explicit acceptance, command ID, expected revision, language and the common document versions/hash. The server derives the actor and live account instance. Record immutable evidence in the existing privacy storage; reject unchecked acceptance, wrong documents, stale revisions and another account's commands. Retrying an ambiguous result reuses the exact command.

Expose standard admission through `GET /privacy/status` as an independent account-admission result. Do not overload `adultDeclared` or change an existing private account's scope. A live ordinary self-account with current common terms, or valid historical own-account admission, satisfies standard admission. Historical access reads and subscription management do not require renewed terms acceptance. New purchases require the applicable current billing terms.

Create a separate common-account notice, terms and optional-cloud document family, with its own versions and exact ES/EN hashes. It contains no assertion of age. Keep historical adult/private document payloads, versions, hashes and evidence immutable; stop deriving those historical hashes from newly edited public legal copy. Selecting a new common document must not silently revoke an existing adult declaration or cloud authorization. Privacy refresh validates the appropriate document family rather than comparing every account against one newly replaced adult hash.

Publish new common-account legal copy and remove invitation/age requirements from standard signup copy. Preserve an accurately described legacy private-account section. Give the revised recurring subscription text a new immutable terms version and hashes; remove its adult-only purchase wording while retaining verified email, Mexico, prices, renewal, cancellation, refund and support conditions. Keep older accepted subscription documents available.

## Frontend behavior

`account.ts/html` keeps existing input validation, unchecked terms, language/document reset, code confirmation, password recovery, account-closure recovery and safe return navigation. Pending signup records common terms evidence. `afterAuth()` completes standard admission without calling `declareAdult`; an interrupted/reloaded signup can finish terms-only admission after sign-in. No local forest or sync service starts merely to admit an account.

Account and Settings use a generic account label for standard users. PrivacyPanel no longer injects age admission into their profile or Settings. It offers separate explicit cloud authorization and retains the historical private-account controls needed for existing users. Standard users can close their own account through the existing backup/receipt flow without an adult declaration; retain legacy minor restrictions and closure/account-instance fences.

Subscription entry, purchase eligibility and error copy use standard own-account eligibility. Replace `canonicalAdult`, `adultAdmissionPending` and `eligibleBuyer` age semantics consistently; a stale technical token cannot override a known private profile. Use the authoritative billing summary and canonical account status. Keep catalog/document matching, purchase availability, verified-email enforcement, explicit recurring acceptance, Mexico selection, pending-payment recovery and account-instance fences. Do not require optional cloud consent to purchase. Existing Portal/cancellation remains available without renewed admission or open public sales.

## Backend and mock integration

Use one explicit standard-own-account admission predicate for billing summary eligibility, checkout validation, the transactional compare-and-swap condition and worker resume/dispatch. It checks the live account instance, ordinary account classification and current applicable terms evidence without asserting adulthood. Update every existing adult-declaration timestamp/hash condition; changing only the HTTP handler would leave valid checkout blocked or allow a worker to use stale eligibility. Keep verified email, billing revision, locking, command replay and closure fencing.

`/access` and individual billing use dedicated backend handlers, not the generic router's adult-admission gate. Preserve their real existing paid/sponsored sources and expiries. Align MockApi's `/access` behavior, which currently reaches global `privacy.admit()`, with those dedicated authenticated reads. New users without an entitlement resolve to Free; signup and checkout redirects never manufacture paid access.

Standard cloud authorization requires standard admission and a separate explicit cloud decision, followed by existing capacity, withdrawal, erasure and lease checks. Existing private-adolescent cloud remains governed by its historical guardian authorizations and responsible-account capacity. Purchasing Premium changes capacity only; it grants no cloud consent.

Do not let common enrollment satisfy historical family/social adult authority. The current helper returns early when `ADULT_PRIVACY_MODE=off`; strengthen that boundary so a common-enrolled terms-only caller, including a Premium caller with technical `adult` identity, cannot use the shortcut. Preserve legacy unenrolled compatibility and applicable historical authority; add no family/social feature. Change only ordinary own-account operations that need the standard path. Keep sponsored-access reads, valid grants and redemption available behind the ordinary self-account and verified-email guard; do not add an age declaration. No real access code is issued, inspected or redeemed during this work. Mock redemption remains fail-closed for arbitrary strings.

Common-enrolled accounts cannot convert through the legacy private-adolescent invitation path in this launch. Preserve the original guarded invitation logic for eligible legacy unenrolled accounts and retain existing private accounts and guardian data. A future common-to-private conversion needs separate review of billing, sponsorship, Portal and concurrency effects; it is outside this design. Add no new guardian signup or conversion flow.

Frontend source contracts/dictionaries, backend vendored contracts, immutable document hashes and generated-config contract validation must agree before any candidate is publishable. Preserve current account-type serialization and existing command compatibility.

## Verification after implementation approval

| Area | Existing coverage to extend | Required evidence |
| --- | --- | --- |
| Signup and re-entry | `account.spec.ts`, `auth.service.spec.ts`, `mock-auth-privacy.spec.ts`, `subscription-route.spec.ts` | ES/EN age-free signup, unchecked terms rejected, email code required, interrupted signup recovery, neutral label, safe navigation, no forged adult/cloud consent, lazy account boundary. |
| Privacy and cloud | `privacy.service.spec.ts`, `privacy-panel.spec.ts`, `mock-api-privacy.spec.ts`, `http-api-privacy.spec.ts`, `sync.service.spec.ts` | Common terms/hash/revision/idempotency checks; standard explicit own-sync; withdrawal and account-switch fences; historical documents and private consents unchanged; common-to-private conversion denied, original eligible legacy invitation behavior preserved. |
| Access and purchases | `access.service.spec.ts`, `mock-api-access.spec.ts`, `mock-api-individual-billing.spec.ts`, `subscription-page.spec.ts`, `account-access-summary.spec.ts` | Verified standard account can purchase without adult declaration; unverified/legacy-private account denied; affirmative recurring terms; actual payment before Premium; existing paid/sponsored sources, expiry, Portal and cancellation preserved. |
| Backend admission and rights | `adult-privacy.test.ts`, `private-adolescents.test.ts`, `post-confirmation-commercial.test.ts`, `pre-signup.test.ts`, `account-closure.test.ts`, `privacy-closure.test.ts` | Terms-only admission, unchanged technical identity, common-to-private conversion denied, original eligible legacy invitation behavior and historical evidence/rights/closure fences preserved; common Premium denied family/social in both `off` and `enforce`, while explicitly authorized own-sync succeeds. |
| Backend checkout persistence | `billing-checkout.test.ts`, `billing-dynamo.test.ts`, `billing-hardening.test.ts`, `billing-first-checkout-recovery.test.ts`, `billing-recovery.test.ts`, `billing-events.test.ts`, `billing-portal-cancellation.test.ts`, `billing-lease-completion.test.ts`, `billing-closure.test.ts` | Same standard predicate at request, transactional CAS and worker retry; stale/replaced/closed accounts rejected; paid-period and Portal lifecycle preserved. |
| Sponsored access | `access-code-redemption.test.ts`, `access-code-storage.test.ts`, `access-code-handlers.test.ts` | Ordinary-account and verified-email authorization, existing grants unchanged, replay/rate/storage protections; synthetic test data only. |
| Browser journeys | `verify-auth.mjs`, `verify-sync.mjs`, `verify-private-privacy-local.mjs`, `verify-billing-private-cloud.mjs`, shared harness | Update age-dependent signup fixtures; exercise standard Free/Premium and legacy private behavior, ES/EN, keyboard/mobile layout, no automatic cloud, local forest unchanged. |

Run the frontend's package-script checks and production validation after implementation:

```text
npm run test:config
npm test -- --watch=false
npm run build -- --base-href /
node tools/validate-built-pwa.mjs --build-dir dist/roadmap2u/browser
```

Use the documented SPA-fallback server for browser verification, then `node tools/run-battery.mjs auth sync private-privacy-local billing-private-cloud`. A nonzero exit or any full-output `OK=false`, `PAGEERROR` or `Error:` fails verification. Check that initial `main-*.js` contains no Cognito/AWS adapter signatures as required by CI.

In the paired backend candidate, use `npm test -- test/adult-privacy.test.ts test/private-adolescents.test.ts test/post-confirmation-commercial.test.ts test/pre-signup.test.ts test/billing-checkout.test.ts test/billing-dynamo.test.ts test/billing-hardening.test.ts test/billing-first-checkout-recovery.test.ts test/billing-recovery.test.ts test/billing-events.test.ts test/billing-portal-cancellation.test.ts test/billing-lease-completion.test.ts test/billing-closure.test.ts test/access-code-redemption.test.ts test/access-code-storage.test.ts test/access-code-handlers.test.ts test/account-closure.test.ts test/privacy-closure.test.ts`, then `npm run check`. Set `ROADMAP2U_FRONTEND_PATH` to the paired frontend candidate for `npm run contracts:check`; use the existing `npm run contracts:sync` workflow for candidate source parity and retain immutable contract locking for a future release.

## Candidate review and rollout risks

Prepare and review paired frontend/backend candidates only after design approval. The material risks are missed CAS/worker adult checks, changing historical document hashes, accidentally replacing entitlements with Free, reopening hidden family/social paths, and misclassifying legacy private accounts from stale tokens. The matrix above must pass against the paired changes before requesting any release action. No deploy, AWS configuration change or real payment/code operation is authorized by this design; stage handoff and publication require a later concrete release decision.
