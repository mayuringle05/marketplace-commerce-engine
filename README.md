# Marketplace Commerce Engine

Deterministic, local-only marketplace commerce engine for the COSMO COMMERCE strategy.

## Current operating decisions

- Repository is intentionally public for now.
- Runtime stays on the operator's local machine.
- No public website or hosted control plane.
- ChatGPT Chat is used interactively for research, challenge, and reviewed decisions.
- ChatGPT is never a required dependency for live order execution.
- No live marketplace, supplier, listing, purchase, refund, or dispatch integration is enabled yet.
- Build one checkpoint at a time and validate it before moving forward.

## Current checkpoint

**Checkpoint 1: deterministic economics core.**

The first implementation proves the money model before any external connector exists:

- integer paise inputs and outputs;
- exact rational arithmetic between rounding boundaries;
- mutually exclusive order outcomes;
- expected contribution and decision profit;
- margin and working-capital ROI gates;
- explicit evidence completeness;
- deterministic stress scenario;
- minimum viable selling-price search.

See:

- `COSMO-COMMERCE-Strategy.md`
- `IMPLEMENTATION-CHECKLIST.md`
- `docs/IMPLEMENTATION-DECISIONS.md`

## Local validation

Requires Node.js 24.12+.

```bash
npm install
npm run check
```

No environment variables or credentials are required for Checkpoint 1.
