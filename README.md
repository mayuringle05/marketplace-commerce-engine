# Marketplace Commerce Engine

Deterministic, local-only marketplace commerce engine for the COSMO COMMERCE strategy.

## Status

The local end-to-end path is a **patched simulation candidate under independent safety re-audit**.

The file-backed workflow and regression suite are green, but that is evidence—not permission to trade. PR #6 must not be merged as production-quality until the patched head receives a fresh independent audit.

It can run this lifecycle entirely on the local machine:

```text
supplier feed
  -> canonical identity
  -> freshness + economics + demand gates
  -> opportunity LIST/WATCH/REJECT
  -> bounded marketplace listing
  -> customer order ingestion
  -> stock/cash reservation
  -> order revalidation
  -> durable purchase intent
  -> idempotent supplier purchase
  -> pack + carrier handover
  -> delivery / RTO / return
  -> settlement reconciliation
  -> matured actual profit
```

The system is **not commercially live**. Real marketplace/supplier mutation is intentionally blocked until Gate 0 contains real evidence and approved access.

See:

- `COSMO-COMMERCE-Strategy.md`
- `IMPLEMENTATION-CHECKLIST.md`
- `docs/IMPLEMENTATION-DECISIONS.md`
- `docs/LOCAL-E2E-STATUS.md`

## Operating decisions

- Repository is intentionally public for now.
- Runtime stays on the operator's local machine.
- No website, hosted dashboard, cloud control plane, Railway, Supabase, or public webhook is required.
- The V1 operator surface is CLI-first.
- SQLite is the local source of operational state.
- Money is stored as integer paise; economics use deterministic rational arithmetic.
- ChatGPT Chat is an interactive research/review layer only.
- ChatGPT cannot authorize listings, purchases, refunds, dispatch, or override hard gates.
- No credentials, customer data, tax identifiers, supplier contracts, or private production data belong in this public repository.
- Local secret values belong in macOS Keychain or ignored local files.

## Requirements

- Node.js 24.12 or newer
- npm
- macOS for Keychain/launchd-specific operator features

Install exact locked dependencies:

```bash
npm ci
```

## Full validation

Run format checks, deterministic lint checks, TypeScript, and the full test suite:

```bash
npm run check
```

Run the file-backed end-to-end commerce simulation:

```bash
npm run demo:e2e -- data/local-e2e.sqlite
```

A successful demo ends with an order in `MATURED`, a confirmed simulated purchase held in independent provider storage, delivered shipment, zero remaining public quantity, and reconciled **fixture** profit. It does not prove real fees, tax treatment, bank settlement, or commercial profitability.

## Gate 0: live-mode boundary

The checked-in example is deliberately fail-closed:

```bash
npm run gate0:status -- config/gate0.example.json
```

It should report `"ready": false`.

For future real operation, copy the example to the ignored local file:

```bash
cp config/gate0.example.json config/gate0.local.json
```

Do not mark a field true until the corresponding real commercial evidence exists.

The Gate 0 JSON/CLI is a **readiness checklist, not transactional authority**. No real adapter exists today. Any future live adapter must independently require versioned, current evidence for the exact account/supplier/route plus explicit owner authorization at its mutation boundary.

Gate 0 covers seller/tax setup, marketplace approval and API access, current rate card, verified supplier/invoice/dispatch/return route, real quotes and allocations, payment terms, capital/reserves, and operator coverage.

## Exposure controls

Runtime starts fail-closed after worker startup.

Inspect state:

```bash
npm run exposure -- status data/commerce.sqlite
```

Pause new sales:

```bash
npm run exposure -- pause data/commerce.sqlite OWNER_PAUSE
```

Resume only after reconciliation:

```bash
npm run exposure -- resume data/commerce.sqlite OWNER_RECONCILED
```

Liquidity shortfall can also force global stop-new-exposure and pause active listings.

## Local worker

Run one due job:

```bash
npm run worker:once -- data/commerce.sqlite
```

Run the continuous local worker:

```bash
npm run worker -- data/commerce.sqlite
```

The worker uses SQLite leases and fencing tokens. Expired/stale workers cannot complete a job with an old fencing token.

A launchd plist can be generated from `src/runtime/launchd.ts` when the Mac is ready to supervise the worker.

## ChatGPT Chat research handoff

Export a small local research packet:

```bash
npm run research -- export data/commerce.sqlite data/chatgpt-inbox.json
```

Use that packet interactively in ChatGPT Chat. Save the schema-compliant decision JSON locally, then import it:

```bash
npm run research -- import data/commerce.sqlite data/chatgpt-decision.json
```

Imported ChatGPT decisions are stored as **not owner-approved** and have no direct transactional authority.

The live runtime does not depend on ChatGPT availability.

## Encrypted database backup

The backup command creates a consistent SQLite snapshot, encrypts it with AES-256-GCM, decrypts a private temporary verification copy, and checks SQLite integrity, foreign keys, and expected commerce schema before atomically replacing the encrypted output. Source/output aliases are rejected.

The mechanism supports a user-chosen destination, but a real **second-device/storage recovery drill is still required** before live operation.

It reads the backup key from `COSMO_BACKUP_KEY_HEX` or macOS Keychain service `cosmo-commerce`, account `backup-key`.

Example:

```bash
npm run backup -- data/commerce.sqlite backups/commerce.sqlite.enc
```

Backup artifacts are ignored by git.

## Important safety behavior

The engine intentionally fails closed when:

- supplier price/stock evidence is stale, expired, missing, or out of stock;
- product identity is weaker than A/B or has a contradiction;
- physical trade-unit verification is absent;
- economics fail minimum profit/margin/cash-ROI or stress gates;
- liquidity cannot cover committed orders, public exposure, refund reserve, and settlement-delay reserve;
- marketplace automated access is not explicitly approved;
- a customer order is cancelled/held before supplier purchase;
- purchase authorization has expired;
- an external purchase result is unknown;
- a worker/account fencing token is stale;
- verified cash evidence is missing/stale or aggregate cash is insufficient;
- a listing decision's exact price/evidence/latest quote no longer matches;
- a purchase authorization is expired, consumed, cancelled, or identity/route evidence was invalidated.

An unknown purchase result becomes `PAYMENT_UNKNOWN / PURCHASE_UNKNOWN` and is quarantined. It is never blindly resubmitted.

## What is still required before real sales

Software simulation is not a substitute for commercial proof. Before any live marketplace or supplier mutation, complete Gate 0 and validate:

- one real supplier;
- one approved marketplace;
- real product mappings and physical package/barcode evidence;
- current marketplace fees/taxes/shipping rules;
- real supplier invoices, allocation/price-lock terms, dispatch SLA, and return route;
- real seller/tax/account setup;
- a tiny owner-approved pilot;
- actual settlement/return economics.

Do not add a live connector merely to make the checklist look complete. Add it only after approved access and real business terms exist.
