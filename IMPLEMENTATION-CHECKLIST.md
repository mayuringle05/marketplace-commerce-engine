# COSMO COMMERCE — Implementation Checklist

> Source of truth: `COSMO-COMMERCE-Strategy.md`.
>
> Build rule: complete one checkpoint at a time. A checkpoint is complete only when its automated tests and manual validation gate pass. Do not enable real listing, procurement, dispatch, refund, or payout-affecting actions before the corresponding gate is explicitly approved.

## Status

- [x] Repository created
- [x] Strategy/build specification added
- [x] Implementation checklist added
- [x] Repository visibility intentionally **public for now** (owner decision)
- [ ] Gate 0 commercial feasibility complete
- [ ] Checkpoint 1 deterministic economics complete — **locked install + format + lint + typecheck + 17/17 tests green in CI; final local owner validation pending**
- [ ] V1a observer complete
- [ ] V1b controlled trading complete
- [ ] V1c bounded automatic operation complete

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

- [ ] Implement exactly one supplier adapter first
- [ ] Prefer agreed API or CSV/JSON
- [ ] Preserve source timestamp/version
- [ ] Persist price, tax, allocation, validity, package data, dispatch location
- [ ] Idempotent import
- [ ] Stale source becomes UNKNOWN/unavailable for new exposure

### Canonical product identity

- [ ] Separate canonical product, packaged trade unit, supplier SKU, marketplace catalogue ID, and seller listing
- [ ] Preserve original identifiers and evidence
- [ ] Validate GTIN/ISBN check digits
- [ ] Exact valid identifier match
- [ ] Brand + MPN/model fallback
- [ ] Variant/pack/condition/edition/region contradiction veto
- [ ] Identity classes A/B/C/D/Conflict
- [ ] Only A/B can later become automation-eligible
- [ ] Approved mapping version and invalidation triggers persisted
- [ ] Physical barcode/package verification required for onboarding/pick

### Minimum viable SQLite database

- [ ] WAL enabled
- [ ] Foreign keys enabled
- [ ] `products`
- [ ] `product_identifiers`
- [ ] `suppliers`
- [ ] `fulfilment_routes`
- [ ] `source_offers`
- [ ] `observations`
- [ ] `listings`
- [ ] `opportunities`
- [ ] `orders`
- [ ] `order_items`
- [ ] `reservations`
- [ ] `purchase_orders`
- [ ] `shipments`
- [ ] `returns`
- [ ] `ledger_entries`
- [ ] `jobs`
- [ ] `audit_events`
- [ ] `exceptions`
- [ ] `rules`
- [ ] `signals_events`
- [ ] Unique order/listing/PO/financial-event invariants
- [ ] No negative reservations/available quota
- [ ] Compare-and-set state/version transitions
- [ ] Immutable order economics snapshots

### Marketplace read adapter

- [ ] Exactly one marketplace first
- [ ] Official/approved API only
- [ ] Read-only permissions where possible
- [ ] Durable cursor
- [ ] Overlapping fetch window
- [ ] Event deduplication
- [ ] Full pagination before watermark advance
- [ ] 429 / Retry-After handling
- [ ] No consumer-page scraping dependency

### Opportunity engine

- [ ] Supplier-first candidate funnel
- [ ] Basic category/risk exclusions
- [ ] Evidence freshness gates
- [ ] Reactive demand mode
- [ ] Predictive/event demand mode
- [ ] Structural demand mode
- [ ] Demand prioritization score `D`
- [ ] Hard gates before opportunity score
- [ ] Opportunity score
- [ ] LIST / WATCH / REJECT state
- [ ] Exact blocking reasons persisted

### Finance observer

- [ ] Immutable source financial events
- [ ] Marketplace receivable tracking
- [ ] Supplier payable tracking
- [ ] Tax components tracked separately
- [ ] Bank/settlement reconciliation
- [ ] Profit based on reconciled/matured outcomes, not listed spread

### V1a validation gate

- [ ] One supplier feed ingests repeatedly without duplicates
- [ ] One exact product mapping independently verified
- [ ] One marketplace read path works through approved access
- [ ] Sample real documents reconcile to engine calculations
- [ ] V1a contains no external marketplace/supplier mutation capability

---

## V1b — Controlled trading

### Listings and exposure

- [ ] Stable seller SKU
- [ ] Desired vs observed remote state
- [ ] Quantity sync
- [ ] Price sync
- [ ] Emergency pause
- [ ] Pause requires remote acknowledgement
- [ ] Exposure remains reserved until remote pause is observed
- [ ] Never reprice an accepted order
- [ ] One supplier stock pool exposed on one channel in V1
- [ ] Disjoint quota rule enforced
- [ ] `public quotas + committed units + safety units <= allocated units`
- [ ] Cash availability also limits public exposure

### Deterministic order state machine

- [ ] RECEIVED
- [ ] HELD
- [ ] RESERVED
- [ ] VALIDATING
- [ ] AUTHORIZED
- [ ] PO_INTENT_RECORDED
- [ ] PO_SUBMITTING
- [ ] PO_CONFIRMED
- [ ] PACK_CONFIRMED
- [ ] HANDOVER_CONFIRMED
- [ ] IN_TRANSIT
- [ ] DELIVERED / RTO / LOST / DAMAGED
- [ ] RECONCILING
- [ ] MATURED
- [ ] CUSTOMER_CANCELLED
- [ ] SUPPLIER_REJECTED
- [ ] IDENTITY_CONFLICT
- [ ] PRICE_BREACH
- [ ] SLA_BREACH
- [ ] PAYMENT_UNKNOWN
- [ ] PARTIAL_FULFILMENT
- [ ] RETURN_OPEN
- [ ] CLAIM_OPEN
- [ ] Every exception has owner, deadline, safe next action, and reserved exposure

### Procurement safety

- [ ] Re-fetch cancellation/hold before purchase
- [ ] Short-lived exact spend authorization
- [ ] Durable PO intent before submission
- [ ] Provider idempotency key where supported
- [ ] Unknown purchase result => PURCHASE_UNKNOWN / quarantine
- [ ] Never blind-retry payment/purchase
- [ ] Exact client PO reference used for reconciliation
- [ ] Definitive rejection/no-charge evidence required before a fresh attempt

### Fulfilment

- [ ] Approved supplier/3PL dispatch route only
- [ ] Seller invoice process established
- [ ] Pack/barcode scan evidence
- [ ] Correct marketplace label/manifest
- [ ] Genuine carrier handover before dispatch confirmation
- [ ] Inbound tracking never substituted for customer outbound tracking

### Returns

- [ ] Marketplace return/refund ingestion
- [ ] RMA eligibility rules
- [ ] Return to approved hub
- [ ] Inspection/grading
- [ ] Supplier credit/buyback reconciliation
- [ ] No double refund
- [ ] Conservative recovery value

### Cash controls

- [ ] Reserve cash for committed orders
- [ ] Reserve cash for outstanding public exposure
- [ ] Settlement-delay model
- [ ] Refund/return reserve
- [ ] Purchase cap
- [ ] Global pause when liquidity gate fails

### V1b validation gate

- [ ] End-to-end sandbox/test-order path passes where supported
- [ ] Small owner-approved real order completes through settlement
- [ ] Actual fees reconciled against forecast
- [ ] Return/RTO path tested where practical
- [ ] Replay/crash tests produce zero duplicate purchase/list/refund/dispatch events

---

## V1c — Bounded automatic operation

### Supplier execution

- [ ] Enable only for a supplier with proven idempotency/reconciliation
- [ ] Exact price/quantity/destination cap
- [ ] No substitutions
- [ ] Browser automation only if contractually/permissibly necessary
- [ ] One mutating browser job at a time per account
- [ ] OTP/CAPTCHA remains human-assisted

### Failure recovery and idempotency

- [ ] Action intent persisted before external side effect
- [ ] Payload hash
- [ ] Monotonic state version
- [ ] Job lease
- [ ] Fencing token
- [ ] Process/account mutation lock
- [ ] SAFE_READ_RETRY
- [ ] AUTH_REQUIRED
- [ ] RATE_LIMIT
- [ ] EXPLICIT_REJECTION
- [ ] UNKNOWN_SIDE_EFFECT
- [ ] VALIDATION_FAILURE
- [ ] POLICY_BLOCK
- [ ] Restart begins in stop-new-exposure mode
- [ ] Reconcile unresolved intents before resuming
- [ ] Crash-injection tests around listing/payment/refund boundaries

### Monitoring cadences

- [ ] New order / quote expiry: immediate authoritative recheck
- [ ] Active volatile: 5–10 min where permitted
- [ ] Active normal: 15–30 min
- [ ] Stable locked allocation: 30–60 min where safe
- [ ] Watchlist: 4–6 h
- [ ] Discovery: daily
- [ ] Seasonal: weekly beyond 30 days, daily nearer event
- [ ] Circuit breaker / exponential backoff
- [ ] Reduce SKU/exposure rather than evade source/platform limits

### Local runtime

- [ ] Next.js/TypeScript control panel on `127.0.0.1`
- [ ] Separate Node worker
- [ ] SQLite jobs table
- [ ] `launchd` supervision on Mac
- [ ] Machine kept powered/awake while accepting sales
- [ ] OS-keychain secrets
- [ ] Encrypted sensitive files
- [ ] Encrypted consistent DB backup to a second storage destination
- [ ] Restore drill tested

### Local UI

- [ ] Today
- [ ] Catalogue
- [ ] Orders & returns
- [ ] Supply
- [ ] Money
- [ ] Research & rules
- [ ] Global pause-new-sales with pending vs confirmed remote state
- [ ] No ambiguous “retry everything” button

### ChatGPT research workflow

- [ ] Interactive/batched only in zero-paid-API V1
- [ ] JSON research inbox/outbox
- [ ] Schema-validated import
- [ ] LLM cannot authorize live listing/order/refund actions
- [ ] Live runtime continues when ChatGPT is unavailable

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
