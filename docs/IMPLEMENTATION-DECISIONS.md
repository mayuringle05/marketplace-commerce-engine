# Implementation decisions

This file records implementation choices made after the original COSMO COMMERCE strategy was written. The original strategy document remains unchanged.

## 2026-10-06

### Repository visibility

The repository remains **public for now** by explicit owner decision.

Consequence: no secrets, credentials, private supplier contracts, customer data, tax identifiers, marketplace tokens, or production databases may be committed.

### Runtime

The system is **local-only**.

There is no hosted website, public dashboard, cloud control plane, Railway service, Supabase service, public webhook receiver, or always-on SaaS dependency in V1.

### User interface

The operator surface is **CLI-first and local-only**. No Next.js control panel or other website is being built in V1 because the owner explicitly requested no website.

Available local operator surfaces include:

- Gate 0 readiness status;
- exposure pause/resume;
- worker loop / one-shot worker;
- research packet export and ChatGPT decision import;
- encrypted database backup;
- deterministic end-to-end demo.

A graphical local UI may be reconsidered later, but the runtime must not depend on one.

### ChatGPT

ChatGPT Chat is the reviewed intelligence layer.

Permitted role:

- research;
- challenge assumptions;
- analyze small reviewed batches;
- propose decisions;
- return structured decision files for local validation/import.

Not permitted as a live transactional dependency:

- automatically accepting orders;
- authorizing spend;
- executing purchases;
- dispatching orders;
- issuing refunds;
- overriding deterministic hard gates.

The local runtime must continue safely when ChatGPT is unavailable.

### Build sequencing

Checkpoint 1 was completed and merged before operational work began.

After local observer slices were individually validated, the owner explicitly requested that the remaining software be implemented end-to-end before the next manual testing cycle. The resulting local build therefore includes simulated marketplace/supplier execution, order/procurement/fulfilment/returns/finance state, job fencing, recovery controls, and operator tooling.

### Live integration boundary

The repository is now **local simulation complete**, not commercially live.

Real marketplace or supplier mutation remains hard-blocked until Gate 0 is fully populated with real commercial evidence: seller entity/tax configuration, approved seller/API access, current rate card, verified supplier/invoice/RMA/dispatch route, real quotations/allocations, capital/reserves, and operator coverage.

The default `config/gate0.example.json` is intentionally all false. The live-readiness checker must report `ready: false` until those facts are supplied locally.

### External adapters

V1 currently contains deterministic local simulated adapters only.

The marketplace read-sync contract refuses sources that do not explicitly declare approved automated access. A real marketplace adapter must use official/approved access and must satisfy the same cursor, deduplication, pagination, and rate-limit contracts.

The supplier execution simulator exists to prove idempotency and UNKNOWN-side-effect recovery. It must not be confused with a verified real supplier integration.
