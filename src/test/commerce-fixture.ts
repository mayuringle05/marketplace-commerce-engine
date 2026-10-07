import type { DatabaseSync } from "node:sqlite";

import {
  recordVerifiedCashSnapshot,
  setCashReservePolicy,
} from "../cash/state.ts";
import { evaluateCandidate } from "../economics/engine.ts";
import { asPaise } from "../economics/money.ts";
import type { EconomicScenario } from "../economics/types.ts";
import { syncListingToSimulatedMarketplace } from "../listings/service.ts";
import { persistOpportunity } from "../opportunities/engine.ts";
import { ingestMarketplaceOrder } from "../orders/ingest.ts";
import { validateAndAuthorizeOrder } from "../orders/authorization.ts";
import { parseSupplierFeedJson } from "../supplier/feed.ts";
import { evaluateLatestSourceOffer } from "../supplier/freshness.ts";
import { importSupplierFeed } from "../supplier/importer.ts";
import {
  initializeRuntimeSafety,
  setStopNewExposure,
} from "../runtime/safety.ts";

export const FIXTURE_T0 = "2026-10-07T00:00:00.000Z";

export interface SingleSkuFixtureOptions {
  readonly allocatedUnits?: number;
  readonly availableUnits?: number;
  readonly cashPaise?: number;
  readonly listingQuantity?: number;
}

export interface SingleSkuFixture {
  readonly sourceOfferId: string;
  readonly supplyPoolId: string;
  readonly opportunityId: string;
  readonly listingId: string;
  readonly peakCashPaise: number;
}

function scenario(): EconomicScenario {
  return {
    customerPriceGrossPaise: asPaise(79_900),
    outputTaxRateBps: 1_800,
    supplier: {
      grossPaise: asPaise(35_000),
      taxRateBps: 1_800,
      recoverableTax: true,
    },
    keptOrderCosts: [
      {
        id: "marketplace-fee",
        kind: "marketplace_fee",
        sourceVersion: "fixture-rates-v1",
        netPaise: asPaise(9_000),
        cashTaxRateBps: 1_800,
        stressEligible: true,
      },
      {
        id: "outbound-logistics",
        kind: "outbound_shipping",
        sourceVersion: "fixture-rates-v1",
        netPaise: asPaise(2_500),
        cashTaxRateBps: 1_800,
        stressEligible: true,
      },
      {
        id: "packing",
        kind: "packing_handling",
        sourceVersion: "fixture-pack-v1",
        netPaise: asPaise(2_000),
        cashTaxRateBps: 1_800,
        stressEligible: false,
      },
    ],
    outcomes: [
      { kind: "kept", probabilityPpm: 870_000 },
      {
        kind: "rto",
        probabilityPpm: 80_000,
        costPaise: asPaise(15_000),
        recoveryPaise: asPaise(0),
      },
      {
        kind: "customer_return",
        probabilityPpm: 50_000,
        costPaise: asPaise(19_000),
        recoveryPaise: asPaise(0),
      },
    ],
    buffers: {
      feeUncertaintyPaise: asPaise(1_000),
      unmodelledPriceRiskPaise: asPaise(1_500),
      supplierRiskPaise: asPaise(1_000),
      allocatedOverheadPaise: asPaise(1_200),
    },
    gates: {
      minimumDecisionProfitPaise: asPaise(10_000),
      minimumDecisionMarginBps: 1_500,
      minimumCashRoiBps: 2_000,
    },
    evidence: {
      feesKnown: true,
      taxTreatmentKnown: true,
      billableWeightAndZoneKnown: true,
    },
    cashRisk: {
      availableSingleOrderLossReservePaise: asPaise(100_000),
    },
  };
}

export function seedSingleSkuFixture(
  database: DatabaseSync,
  options: SingleSkuFixtureOptions = {},
): SingleSkuFixture {
  const allocatedUnits = options.allocatedUnits ?? 5;
  const availableUnits = options.availableUnits ?? allocatedUnits;
  const cashPaise = options.cashPaise ?? 250_000;
  const listingQuantity = options.listingQuantity ?? 1;

  initializeRuntimeSafety(database, FIXTURE_T0);

  database
    .prepare(
      `
        INSERT INTO products (
          id, brand, manufacturer, model, mpn, condition,
          market_region, created_at, updated_at
        ) VALUES (
          'product-1', 'Acme', 'Acme', 'Model 1', 'MPN-1',
          'new', 'IN', ?, ?
        )
      `,
    )
    .run(FIXTURE_T0, FIXTURE_T0);

  database
    .prepare(
      `
        INSERT INTO suppliers (
          id, legal_name, status, created_at, updated_at
        ) VALUES (
          'supplier-1', 'Supplier One', 'verified', ?, ?
        )
      `,
    )
    .run(FIXTURE_T0, FIXTURE_T0);

  database
    .prepare(
      `
        INSERT INTO fulfilment_routes (
          id, supplier_id, dispatch_country, dispatch_region,
          single_unit_dispatch_verified, return_route_verified,
          active, created_at, updated_at
        ) VALUES (
          'route-1', 'supplier-1', 'IN', 'KA',
          1, 1, 1, ?, ?
        )
      `,
    )
    .run(FIXTURE_T0, FIXTURE_T0);

  importSupplierFeed(
    database,
    parseSupplierFeedJson(
      JSON.stringify({
        supplierId: "supplier-1",
        sourceVersion: "quote-v1",
        sourceRef: "fixture-feed",
        observedAt: "2026-10-07T00:05:00.000Z",
        offers: [
          {
            productId: "product-1",
            fulfilmentRouteId: "route-1",
            supplierSku: "SKU-1",
            grossCostPaise: 35_000,
            taxRateBps: 1_800,
            allocatedUnits,
            availableUnits,
            validFrom: "2026-10-07T00:00:00.000Z",
            validUntil: "2026-10-08T00:00:00.000Z",
            package: {
              packedWeightGrams: 650,
              lengthMm: 220,
              widthMm: 160,
              heightMm: 90,
            },
          },
        ],
      }),
    ),
  );

  database
    .prepare(
      `
        INSERT INTO packaged_trade_units (
          id, product_id, variant, edition, pack_count, condition,
          market_region, barcode_type, barcode_value, mapping_version,
          mapping_status, invalidation_reason, created_at, updated_at,
          physical_verified_at
        ) VALUES (
          'trade-1', 'product-1', 'standard', '2026', 1, 'new',
          'IN', 'GTIN13', '4006381333931', 1,
          'APPROVED', NULL, ?, ?, ?
        )
      `,
    )
    .run(
      FIXTURE_T0,
      FIXTURE_T0,
      "2026-10-07T00:06:00.000Z",
    );

  database
    .prepare(
      `
        INSERT INTO marketplace_catalogue_items (
          id, marketplace, marketplace_catalogue_id, trade_unit_id,
          identity_class, mapping_version, mapping_status,
          evidence_ref, created_at, updated_at
        ) VALUES (
          'market-item-1', 'SIM', 'CAT-1', 'trade-1',
          'A', 1, 'APPROVED', 'fixture-identity', ?, ?
        )
      `,
    )
    .run(FIXTURE_T0, FIXTURE_T0);

  const source = database
    .prepare(
      `
        SELECT
          s.id,
          link.pool_id
        FROM source_offers s
        JOIN source_offer_supply_pools link
          ON link.offer_id = s.id
        WHERE s.supplier_id = 'supplier-1'
          AND s.supplier_sku = 'SKU-1'
      `,
    )
    .get() as { id: string; pool_id: string };

  const economics = evaluateCandidate(scenario());
  const freshness = evaluateLatestSourceOffer(
    database,
    "supplier-1",
    "SKU-1",
    "2026-10-07T00:10:00.000Z",
    { maximumObservationAgeSeconds: 1_800 },
  );
  const opportunityId = persistOpportunity(database, {
    productId: "product-1",
    tradeUnitId: "trade-1",
    sourceOfferId: source.id,
    marketplace: "SIM",
    approvedPricePaise: 79_900,
    sourceFreshUntil: "2026-10-07T00:35:00.000Z",
    identityClass: "A",
    freshness,
    routeVerified: true,
    categoryAllowed: true,
    economics,
    demand: {
      reactive: 95,
      predictive: 90,
      structural: 95,
    },
    evidenceVersion: "fixture-evidence-v1",
    createdAt: "2026-10-07T00:10:00.000Z",
  });

  recordVerifiedCashSnapshot(
    database,
    cashPaise,
    "fixture-bank",
    "2026-10-07T00:09:00.000Z",
    "2026-10-07T01:00:00.000Z",
  );
  setCashReservePolicy(
    database,
    0,
    0,
    "2026-10-07T00:09:00.000Z",
  );
  setStopNewExposure(
    database,
    false,
    "FIXTURE_READY",
    "2026-10-07T00:10:30.000Z",
  );

  const listingId = syncListingToSimulatedMarketplace(
    database,
    {
      marketplace: "SIM",
      sellerSku: "SELLER-1",
      marketplaceCatalogueItemId: "market-item-1",
      opportunityId,
      sourceOfferId: source.id,
      pricePaise: 79_900,
      requestedQuantity: listingQuantity,
      updatedAt: "2026-10-07T00:11:00.000Z",
    },
  );

  return {
    sourceOfferId: source.id,
    supplyPoolId: source.pool_id,
    opportunityId,
    listingId,
    peakCashPaise: Number(
      economics.base.peakCashRequirementPaise,
    ),
  };
}

export function ingestSingleOrder(
  database: DatabaseSync,
  suffix = "1",
): string {
  return ingestMarketplaceOrder(database, {
    marketplace: "SIM",
    marketplaceOrderId: `ORDER-${suffix}`,
    marketplaceItemId: `ORDER-${suffix}-ITEM-1`,
    sellerSku: "SELLER-1",
    quantity: 1,
    acceptedPricePaise: 79_900,
    receivedAt: "2026-10-07T00:12:00.000Z",
    economicsSnapshot: {
      fixture: "single-sku",
      acceptedPricePaise: 79_900,
    },
  });
}

export function authorizeSingleOrder(
  database: DatabaseSync,
  orderId: string,
  sourceOfferId: string,
): void {
  validateAndAuthorizeOrder(database, {
    orderId,
    sourceOfferId,
    authorizedAt: "2026-10-07T00:12:30.000Z",
  });
}
