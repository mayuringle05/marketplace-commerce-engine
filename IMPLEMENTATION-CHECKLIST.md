# COSMO COMMERCE — Implementation Checklist

> Source of truth: `COSMO-COMMERCE-Strategy.md`.
>
> Build rule: complete one checkpoint at a time. A checkpoint is complete only when its automated tests and manual validation gate pass. Do not enable real listing, procurement, dispatch, refund, or payout-affecting actions before the corresponding gate is explicitly approved.

## Status

- [x] Repository created
- [x] Strategy/build specification added
- [x] Implementation checklist added
- [x] Repository visibility intentionally **public for now** (owner decision)
- [ ] Gate 0 commercial feasibility complete — **real commercial evidence still required**
- [x] Checkpoint 1 deterministic economics complete — **merged to main; local economics validation passed and full locked CI is green**
- [ ] Patched local end-to-end simulation production-quality — **workflow is green; independent re-audit of the patched PR head still required**
- [ ] V1a live observer validation complete — **real approved marketplace read path + real documents pending**
- [ ] V1b live controlled-trading validation complete — **real owner-approved order pending**
- [ ] V1c live bounded automatic operation complete — **promotion evidence and real supplier execution pending**

---

## Gate 0 — Commercial feasibility

This gate follows the strategy's pre-build commercial acceptance sheet. Live connectors stay disabled until the critical fields are real, not assumed.

- [ ] Legal seller entity decided
- [ ] GST/tax regime confirmed for the actual route
- [ ] One marketplace seller account/category approved
- [ ] Current marketplace rate card captured with effective date
- [ ] Required official API roles/access approved
- [ ] One legitimate supplier/distributor selected
- [ ] Supplier legal entity/GSTIN and bank beneficiary independently verified
- [ ] Supplier invoice sample verified
- [ ] Exact 10–20 candidate SKU quotations obtained
- [ ] Allocated/reserved units and validity documented
- [ ] Quote validity / price-lock terms documented
- [ ] Single-unit dispatch capability proven
- [ ] Approved dispatch location proven
- [ ] Approved return/RMA route proven
- [ ] Packed weight and dimensions available
- [ ] Pick/pack and carrier cutoffs documented
- [ ] Payment terms / working-capital requirement documented
- [ ] Dedicated available capital and reserves set
- [ ] Local runtime coverage and operator escalation coverage set

### Gate 0 validation

- [ ] At least one candidate SKU passes identity, route, fee, cash, SLA, and stress gates using real inputs
- [ ] No critical acceptance-sheet field remains unknown
- [ ] If allocation + invoice compliance + single-unit fulfilment cannot be secured economically, STOP instead of coding around it

---

## Checkpoint 1 — Deterministic economics foundation

### Repository foundation

- [x] Initialize Node.js + TypeScript
- [x] Strict TypeScript configuration
- [x] Lint / formatting
- [x] Unit-test runner
- [x] GitHub Actions CI
- [x] `.gitignore`
- [x] `.env.example` with placeholders only
- [x] No committed secrets

### Money model

- [x] Money represented as integer paise
- [x] Rates represented as integer basis points / rational arithmetic
- [x] Explicit rounding rules at fee/invoice boundaries
- [x] Economic profit separated from gross cash and tax accounting
- [x] Marketplace fees are versioned inputs, not one hard-coded percentage
- [x] Supplier cost and recoverable/non-recoverable tax are explicit
- [x] Forward shipping/fulfilment costs are explicit
- [x] Return/RTO costs are explicit
- [x] Packing/handling costs are explicit
- [x] Fee uncertainty buffer
- [x] Unmodelled price-risk buffer
- [x] Supplier-risk buffer
- [x] Allocated overhead

### Mutually exclusive outcome model

- [x] Cancellation before purchase
- [x] Cancellation after purchase
- [x] Delivered and kept
- [x] RTO
- [x] Post-delivery return
- [x] Lost/damaged
- [x] Outcome probabilities must sum to one
- [x] Conditional return probability is converted correctly before weighting
- [x] No double-counting of return reserves/recoveries

### Core calculations

- [x] `expected_contribution`
- [x] `decision_profit`
- [x] Decision margin on net sales
- [x] Peak per-order cash requirement
- [x] Cash ROI
- [x] Minimum economic price search over allowed price ticks

### Hard money gates

- [x] Decision profit >= ₹100
- [x] Decision profit >= 15% of net sales
- [x] Decision profit >= 20% of peak per-order cash requirement
- [x] Unknown material fee => WATCH
- [x] Unknown tax treatment => WATCH
- [x] Unknown billable weight/zone => WATCH

### Stress tests

- [x] Source cost +10%
- [x] Logistics/fees +15%
- [x] Return/RTO probabilities ×1.5 with consistent renormalization
- [x] Stressed decision profit remains non-negative
- [x] Complete loss of one order tested separately against cash reserve

### Automated tests

- [x] Section 28 example reproduces approximately ₹145.09 decision profit
- [x] Kept-order example reproduces approximately ₹227.03 contribution before overhead
- [x] ₹350 → ₹510 supplier-cost change materially collapses profitability
- [x] Low-margin product rejects
- [x] Negative expected contribution rejects
- [x] Shipping increase can flip LIST/PASS → REJECT
- [x] Marketplace fee increase can flip LIST/PASS → REJECT
- [x] Return-risk increase can flip LIST/PASS → REJECT
- [x] Rounding is deterministic
- [x] Same input always returns the same output
- [x] Invalid/overflow/negative inputs fail safely

### Checkpoint 1 validation gate

- [x] Fresh checkout installs successfully
- [x] Typecheck passes
- [x] Lint passes
- [x] Unit tests pass
- [x] GitHub CI passes
- [x] One human hand-calculation matches the engine
- [x] No supplier or marketplace credentials are required yet

---

## V1a — Observer

### Supplier import

- [x] Implement exactly one supplier adapter first
- [x] Prefer agreed API or CSV/JSON
- [x] Preserve source timestamp/version
- [x] Persist price, tax, allocation, validity, package data, dispatch location
- [x] Idempotent import
- [x] Stale source becomes UNKNOWN/unavailable for new exposure

### Canonical product identity

- [x] Separate canonical product, packaged trade unit, supplier SKU, marketplace catalogue ID, and seller listing
- [x] Preserve original identifiers and evidence
- [x] Validate GTIN/ISBN check digits
- [x] Exact valid identifier match
- [x] Brand + MPN/model fallback
- [x] Variant/pack/condition/edition/region contradiction veto
- [x] Identity classes A/B/C/D/Conflict
- [x] Only A/B can later become automation-eligible
- [x] Approved mapping version and invalidation triggers persisted
- [x] Physical barcode/package verification required for onboarding/pick

### Minimum viable SQLite database

- [x] WAL enabled
- [x] Foreign keys enabled
- [x] `products`
- [x] `product_identifiers`
- [x] `suppliers`
- [x] `fulfilment_routes`
- [x] `source_offers`
- [x] `observations`
- [x] `listings`
- [x] `opportunities`
- [x] `orders`
- [x] `order_items`
- [x] `reservations`
- [x] `purchase_orders`
- [x] `shipments`
- [x] `returns`
- [x] `ledger_entries`
- [x] `jobs`
- [x] `audit_events`
- [x] `exceptions`
- [x] `rules`
- [x] `signals_events`
- [x] Unique order/listing/PO/financial-event invariants
- [x] No negative reservations/available quota
- [x] Compare-and-set state/version transitions
- [x] Immutable order economics snapshots

### Marketplace read adapter

- [x] Exactly one local marketplace adapter first — **SIM adapter implemented**
- [ ] Real marketplace official/approved API connector — **Gate 0/API access pending**
- [ ] Real marketplace read-only permissions where possible — **account configuration pending**
- [x] Durable cursor
- [ ] Overlapping fetch window — **real provider cursor semantics pending**
- [x] Event deduplication
- [x] Full pagination before watermark advance
- [x] 429 / Retry-After handling
- [x] No consumer-page scraping dependency

### Opportunity engine

- [x] Supplier-first flow — **local opportunities originate from imported supplier offers**
- [x] Basic category/risk exclusion gate — **deterministic allow/block input; real category policy data pending**
- [x] Evidence freshness gates
- [x] Reactive demand mode
- [x] Predictive/event demand mode
- [x] Structural demand mode
- [x] Demand prioritization score `D`
- [x] Hard gates before opportunity score
- [x] Opportunity score
- [x] LIST / WATCH / REJECT state
- [x] Exact blocking reasons persisted

### Finance observer

- [x] Immutable source financial events
- [x] Marketplace receivable tracking
- [x] Supplier payable tracking
- [x] Tax components tracked separately
- [x] Simulated document/bank reconciliation engine with exact replay/conflict checks
- [x] Fixture profit based on reconciled/matured economic events, not listed spread; **real statements/tax/bank evidence pending**

### V1a validation gate

- [x] One supplier feed ingests repeatedly without duplicates — **local fixture**
- [ ] One exact product mapping independently verified — **real physical/product evidence pending**
- [ ] One marketplace read path works through approved access — **real credentials/access pending**
- [ ] Sample real documents reconcile to engine calculations — **real statements/invoices pending**
- [x] Local observer contains no real external marketplace/supplier mutation capability

---

## V1b — Controlled trading

### Listings and exposure

- [x] Stable seller SKU
- [x] Desired vs observed remote state
- [x] Quantity sync
- [x] Price sync
- [x] Emergency pause
- [x] Pause requires remote acknowledgement — **proven against simulated remote adapter**
- [x] Exposure/pause state is not confirmed until simulated remote pause is observed
- [x] Never reprice an accepted order
- [x] One supplier stock pool exposed on one channel in V1
- [x] Disjoint quota rule enforced
- [x] `public quotas + committed units + safety units <= allocated units`
- [x] Cash availability also limits public exposure

### Deterministic order state machine

- [x] RECEIVED
- [x] HELD
- [x] RESERVED
- [x] VALIDATING
- [x] AUTHORIZED
- [x] PO_INTENT_RECORDED
- [x] PO_SUBMITTING
- [x] PO_CONFIRMED
- [x] PACK_CONFIRMED
- [x] HANDOVER_CONFIRMED
- [x] IN_TRANSIT
- [x] DELIVERED / RTO / LOST / DAMAGED
- [x] RECONCILING
- [x] MATURED
- [x] CUSTOMER_CANCELLED
- [x] SUPPLIER_REJECTED
- [x] IDENTITY_CONFLICT
- [x] PRICE_BREACH
- [x] SLA_BREACH
- [x] PAYMENT_UNKNOWN
- [x] PARTIAL_FULFILMENT
- [x] RETURN_OPEN
- [x] CLAIM_OPEN
- [x] Exception schema requires owner/deadline/safe-next-action/exposure flag; PURCHASE_UNKNOWN path validated

### Procurement safety

- [x] Re-fetch cancellation/hold before purchase
- [x] Short-lived exact spend authorization
- [x] Durable PO intent before submission
- [x] Provider idempotency key where supported
- [x] Unknown purchase result => PURCHASE_UNKNOWN / quarantine
- [x] Never blind-retry payment/purchase
- [x] Exact client PO reference used for reconciliation
- [ ] Definitive rejection/no-charge evidence required before a fresh attempt — **new-attempt workflow intentionally not enabled yet**

### Fulfilment

- [x] Route verification gate exists in local authorization/simulation
- [ ] Real approved supplier/3PL dispatch route — **commercial proof pending**
- [ ] Seller invoice process established — **real supplier/account process pending**
- [x] Pack/barcode scan evidence
- [x] Label/tracking identity required by local fulfilment state machine
- [x] Genuine carrier handover evidence required before dispatch confirmation
- [x] One customer-outbound tracking identity is persisted; no inbound tracking substitution path exists

### Returns

- [x] Local/simulated marketplace return/refund ingestion path
- [ ] Real marketplace return feed + RMA eligibility rules — **provider/account rules pending**
- [ ] Real return to approved hub — **commercial route pending**
- [x] Inspection/grading
- [x] Supplier recovery/credit can be reconciled as realized recovery
- [x] No double refund
- [x] Conservative realized recovery value is separated from forecast reserves

### Cash controls

- [x] Reserve cash for committed orders
- [x] Reserve cash for outstanding public exposure
- [x] Settlement-delay model
- [x] Refund/return reserve
- [x] Purchase cap
- [x] Global pause when liquidity gate fails

### V1b validation gate

- [x] Local file-backed end-to-end simulated order reaches MATURED and reconciles fixture profit
- [ ] Marketplace sandbox/test-order path — **real provider access pending**
- [ ] Small owner-approved real order completes through settlement
- [ ] Actual fees reconciled against forecast
- [x] Local return/RTO reconciliation paths tested
- [x] Independent simulated-provider crash/replay/fencing tests cover provider-success/local-failure and reconciliation without resubmission; **real provider contract testing pending**

---

## V1c — Bounded automatic operation

### Supplier execution

- [x] Simulated supplier adapter proves idempotency/reconciliation contract
- [x] Exact price/quantity/destination authorization is persisted and expires
- [x] No substitution path exists in local purchase payload
- [ ] Enable real supplier mutation only after supplier idempotency/reconciliation is proven
- [ ] Browser automation only if contractually/permissibly necessary — **not built because no real need is established**
- [ ] One mutating browser job at a time per account — **N/A until a permitted browser-only supplier is chosen**
- [ ] OTP/CAPTCHA remains human-assisted — **N/A until such a provider is chosen**

### Failure recovery and idempotency

- [x] Action intent persisted before external side effect
- [x] Payload hash
- [x] Monotonic state version
- [x] Job lease
- [x] Fencing token
- [x] Process/account mutation lock
- [x] SAFE_READ_RETRY
- [x] AUTH_REQUIRED
- [x] RATE_LIMIT
- [x] EXPLICIT_REJECTION
- [x] UNKNOWN_SIDE_EFFECT
- [x] VALIDATION_FAILURE
- [x] POLICY_BLOCK
- [x] Restart begins in stop-new-exposure mode
- [x] Restart defaults to stop-new-exposure; PURCHASE_UNKNOWN has reconciliation path before normal continuation
- [ ] Full crash-injection matrix around every external boundary — **purchase unknown/fencing/replay cases covered; real-provider crash injection pending**

### Monitoring cadences

- [x] Deterministic cadence policy includes immediate critical recheck
- [x] Active volatile: 5 min policy
- [x] Active normal: 15 min policy
- [x] Stable locked allocation: 30 min policy
- [x] Watchlist: 4 h policy
- [x] Discovery: daily policy
- [x] Seasonal: weekly far / daily near policy
- [x] Circuit breaker / bounded exponential backoff
- [x] Architecture pauses/reduces exposure rather than evading source/platform limits
- [ ] Provider-specific scheduler wiring — **depends on real approved API/source limits**

### Local runtime

- [x] CLI-first local operator surface — **supersedes planned Next.js control panel per owner decision**
- [x] Separate Node worker
- [x] SQLite jobs table
- [x] `launchd` plist generator implemented
- [ ] Actual macOS launchd lifecycle tested on the operator Mac
- [ ] Machine kept powered/awake while accepting real sales — **operator/hardware configuration pending**
- [x] macOS Keychain reader implemented
- [ ] Actual Keychain retrieval exercised on the operator Mac
- [x] Sensitive DB backups encrypted with AES-256-GCM; live credentials remain outside repo/Keychain
- [x] Encrypted consistent DB backup mechanism with alias protection and verified atomic output
- [ ] Backup/restore drill from a genuinely separate storage/device
- [x] Disposable file restore integrity/foreign-key/schema drill tested

### Local operator surface

- [x] No website/UI by owner decision; CLI is the V1 operator surface
- [x] Exposure status / pause / resume CLI
- [x] Research export/import CLI
- [x] Worker one-shot / supervised loop commands
- [x] Gate 0 readiness CLI — **status only; not live transactional authority**
- [x] Encrypted backup/integrity CLI
- [x] No ambiguous “retry everything” command exists

### ChatGPT research workflow

- [x] Interactive/batched only in zero-paid-API V1
- [x] JSON research inbox/outbox
- [x] Schema-validated import
- [x] LLM cannot authorize live listing/order/refund actions
- [x] Live runtime continues when ChatGPT is unavailable

### V1c validation gate

- [ ] Matured-order profit positive across pilot cohort
- [ ] Intervention rate measured per eligible matured order
- [ ] Supplier exact-fill/on-time reliability measured from own orders
- [ ] Zero unresolved duplicate side effects
- [ ] Exception backlog stays inside SLA
- [ ] Autonomy increases only after evidence thresholds pass

---

## V2 — Only after V1 evidence

- [ ] Add second supplier
- [ ] Add second marketplace only with disjoint quotas
- [ ] Use own mature-order data for outcome/demand estimates
- [ ] Consider always-on infrastructure only if local hardware is inadequate
- [ ] Consider authorized paid LLM API only if ROI justifies it
- [ ] Consider licensed price history / OMS / 3PL integrations only if measured savings justify them

---

## Permanent non-goals / prohibited shortcuts

- [ ] Do not build a millions-of-products crawler
- [ ] Do not build rotating-proxy/CAPTCHA-bypass scraping
- [ ] Do not put a controller LLM on live transactional orders
- [ ] Do not automate extraction from consumer ChatGPT as a free API substitute
- [ ] Do not build a generalized adapter framework before one supplier/channel works
- [ ] Do not share the same final stock unit across marketplaces in V1
- [ ] Do not create catalogue listings from approximate product matches
- [ ] Do not price-war below the economic floor
- [ ] Do not auto-refund blindly
- [ ] Do not auto-substitute
- [ ] Do not blind-retry unknown payments/purchases
- [ ] Do not add public cloud/webhook dependencies to V1 without a demonstrated requirement
- [ ] Do not treat this app as a GST/accounting filing replacement
- [ ] Do not report listed spread or pending settlement as realized profit
- [ ] Do not add paid ads before organic unit economics are proven
- [ ] Do not use retail coupon arbitrage, imports, fashion, customization, or unsafe/high-support products in V1

---

## Pilot success metrics

- [ ] Matured contribution profit/order
- [ ] Forecast-vs-realized decision-profit error
- [ ] Supplier exact-fill rate
- [ ] Supplier on-time dispatch rate
- [ ] RTO rate
- [ ] Return rate
- [ ] Return recovery rate
- [ ] Marketplace fee forecast error
- [ ] Settlement-delay distribution
- [ ] Capital-days / cash tied up per order
- [ ] Human minutes per eligible matured order
- [ ] Exception rate
- [ ] Duplicate side effects = 0
- [ ] Policy/account-health blocks = 0

---

## First implementation target

**Checkpoint 1 only: deterministic economics engine + tests + GitHub CI.**

Do not connect a live supplier or marketplace until Checkpoint 1 is green and Gate 0 commercial inputs begin to exist.
