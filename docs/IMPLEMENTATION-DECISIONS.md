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

No web UI is being built in Checkpoint 1.

A local UI may be reconsidered later only if it is genuinely useful. The deterministic engine, worker, database, and connectors must not depend on a UI.

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

Implement and validate one checkpoint at a time. Do not start supplier/marketplace integration until the deterministic economics checkpoint is green.
