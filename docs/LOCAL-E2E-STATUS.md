# Local End-to-End Status

## Current truth

The patched software path executes end to end **as a deterministic local simulation candidate**. A fresh independent re-audit of the patched PR head is still required before calling the simulation production-quality.

It is not yet a live marketplace business. The repository contains no real marketplace credentials, supplier credentials, customer data, private contracts, or live production database.

## Proven locally and in CI

The current branch proves:

- locked reproducible install;
- format, lint, and strict TypeScript checks;
- integer-paise deterministic economics and stress gates;
- supplier feed replay safety and source freshness;
- GTIN/ISBN/MPN identity classification and contradiction vetoes;
- physical trade-unit verification gate;
- supplier-first opportunity scoring;
- reactive, predictive, and structural demand evidence aggregation;
- LIST / WATCH / REJECT with exact blocking reasons;
- quota/cash-bounded listing exposure;
- accepted-order public quantity consumption;
- order state/version compare-and-set;
- stock and cash reservation;
- authoritative marketplace-order recheck before supplier purchase;
- short-lived purchase authorization;
- durable purchase intent and idempotency key;
- PURCHASE_UNKNOWN quarantine and reconciliation without blind retry;
- pack/barcode, label, handover, transit, delivery/RTO paths;
- return grading and realized recovery;
- source-line-scoped immutable financial events with changed-replay rejection and document/bank-backed fixture maturity;
- job leases, fencing tokens, account locks, and fail-closed startup;
- durable marketplace read cursors, full-page transactionality, event dedupe, approved-access gate, and Retry-After handling;
- liquidity circuit breaker and global exposure pause;
- monitoring cadence/backoff policy;
- file-based ChatGPT research handoff with zero transaction authority;
- AES-256-GCM consistent SQLite backup and restore integrity test;
- launchd worker supervision template;
- DB-level immutability guards;
- mapping invalidation that pauses affected listings;
- a file-backed end-to-end demo from supplier offer to matured profit.

## Current CI acceptance

CI must pass three layers:

1. `npm run check`
2. file-backed `npm run demo:e2e`
3. fail-closed Gate 0 check

The demo's reference fixture matures one delivered order and reconciles ₹215.03 from its supplied fixture documents/costs. This proves deterministic fixture reconciliation only; it is not evidence of actual marketplace profit, GST treatment, or bank settlement.

## Intentionally not claimed as complete

These require external evidence and therefore remain open:

- legal seller entity / tax regime confirmation;
- approved real marketplace seller account;
- approved real marketplace API roles and permissions;
- current real marketplace rate card;
- real supplier legal identity and invoices;
- actual quotations, allocations, validity windows, and price-lock terms;
- real dispatch/return route and SLA;
- real package/barcode verification;
- real payment terms and working-capital limits;
- real seller invoice process;
- provider-specific marketplace/supplier adapters;
- marketplace sandbox/real test order where supported;
- actual marketplace statement, supplier invoice, tax/withholding treatment, and bank reconciliation;
- owner-approved small live pilot;
- live return/RTO pilot evidence;
- pilot reliability, intervention, and matured-profit metrics.

## Promotion rule

Do not enable real external mutation because the simulator is green.

Real mutation may be considered only when:

1. the patched technical head passes independent re-audit;
2. Gate 0 is fully supported by versioned evidence (the boolean checklist alone is insufficient);
3. an approved real connector is implemented against official/permitted access and enforces that evidence at its mutation boundary;
4. observer-mode reconciliation passes;
5. owner reviews the exact first listing/order/supplier/route/spend cap;
6. the pilot starts at deliberately tiny exposure.

The system must remain fail-closed if any of those prerequisites is unknown.
