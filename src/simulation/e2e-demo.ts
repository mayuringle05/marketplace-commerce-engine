import type { DatabaseSync } from "node:sqlite";

import { evaluateCandidate } from "../economics/engine.ts";
import { asPaise } from "../economics/money.ts";
import type { EconomicScenario } from "../economics/types.ts";
import {
  recordVerifiedCashSnapshot,
  setCashReservePolicy,
} from "../cash/state.ts";
import {
  markInTransit,
  markShipmentOutcome,
  confirmCarrierHandover,
  confirmPack,
} from "../fulfilment/service.ts";
import { reconcileDeliveredKeptOrder } from "../finance/ledger.ts";
import { syncListingToSimulatedMarketplace } from "../listings/service.ts";
import { ingestMarketplaceOrder } from "../orders/ingest.ts";
import { validateAndAuthorizeOrder } from "../orders/authorization.ts";
import {
  recordPurchaseIntent,
  submitPurchaseOnce,
} from "../procurement/service.ts";
import { persistOpportunity } from "../opportunities/engine.ts";
import {
  evaluateLatestSourceOffer,
} from "../supplier/freshness.ts";
import { parseSupplierFeedJson } from "../supplier/feed.ts";
import { importSupplierFeed } from "../supplier/importer.ts";
import {
  SimulatedSupplierPurchaseAdapter,
} from "../supplier/simulated-purchase.ts";
import {
  initializeRuntimeSafety,
  setStopNewExposure,
} from "../runtime/safety.ts";

export interface DemoSummary {
  readonly orderId: string;
  readonly finalOrderState: string;
  readonly opportunityState: string;
  readonly listingState: string;
  readonly listingQuantity: bigint;
  readonly purchaseState: string;
  readonly shipmentState: string;
  readonly recognizedProfitPaise: bigint;
  readonly auditEventCount: bigint;
}

const T0 = "2026-10-07T00:00:00.000Z";

function seedCommercialFixture(database: DatabaseSync): void {
  database
    .prepare(
      `
        INSERT INTO products (
          id,
          brand,
          manufacturer,
          model,
          mpn,
          condition,
          market_region,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, 'new', 'IN', ?, ?)
      `,
    )
    .run(
      "product-1",
      "Acme",
      "Acme Manufacturing",
      "Office Tool Set",
      "ACME-OTS-1",
      T0,
      T0,
    );

  database
    .prepare(
      `
        INSERT INTO product_identifiers (
          product_id,
          identifier_type,
          normalized_value,
          evidence_class,
          source_ref,
          created_at
        ) VALUES (?, 'GTIN13', ?, 'A', ?, ?)
      `,
    )
    .run(
      "product-1",
      "4006381333931",
      "manufacturer-fixture",
      T0,
    );

  database
    .prepare(
      `
        INSERT INTO suppliers (
          id,
          legal_name,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, 'verified', ?, ?)
      `,
    )
    .run(
      "supplier-1",
      "Acme Authorized Distributor Pvt Ltd",
      T0,
      T0,
    );

  database
    .prepare(
      `
        INSERT INTO fulfilment_routes (
          id,
          supplier_id,
          dispatch_country,
          dispatch_region,
          single_unit_dispatch_verified,
          return_route_verified,
          active,
          created_at,
          updated_at
        ) VALUES (?, ?, 'IN', 'KA', 1, 1, 1, ?, ?)
      `,
    )
    .run("route-1", "supplier-1", T0, T0);

  importSupplierFeed(
    database,
    parseSupplierFeedJson(
      JSON.stringify({
        supplierId: "supplier-1",
        sourceVersion: "demo-quote-v1",
        sourceRef: "demo-supplier.json",
        observedAt: "2026-10-07T00:05:00.000Z",
        offers: [
          {
            productId: "product-1",
            fulfilmentRouteId: "route-1",
            supplierSku: "ACME-SKU-001",
            grossCostPaise: 35_000,
            taxRateBps: 1_800,
            allocatedUnits: 5,
            availableUnits: 5,
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
          id,
          product_id,
          variant,
          edition,
          pack_count,
          condition,
          market_region,
          barcode_type,
          barcode_value,
          mapping_version,
          mapping_status,
          invalidation_reason,
          created_at,
          updated_at,
          physical_verified_at
        ) VALUES (?, ?, ?, ?, 1, 'new', 'IN', 'GTIN13', ?, 1, 'APPROVED', NULL, ?, ?, ?)
      `,
    )
    .run(
      "trade-unit-1",
      "product-1",
      "standard",
      "2026",
      "4006381333931",
      T0,
      T0,
      "2026-10-07T00:06:00.000Z",
    );

  database
    .prepare(
      `
        INSERT INTO marketplace_catalogue_items (
          id,
          marketplace,
          marketplace_catalogue_id,
          trade_unit_id,
          identity_class,
          mapping_version,
          mapping_status,
          evidence_ref,
          created_at,
          updated_at
        ) VALUES (?, 'SIM', ?, ?, 'A', 1, 'APPROVED', ?, ?, ?)
      `,
    )
    .run(
      "market-item-1",
      "SIM-CATALOGUE-1",
      "trade-unit-1",
      "fixture:A",
      T0,
      T0,
    );
}

function underwritingScenario(): EconomicScenario {
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
        sourceVersion: "sim-rate-card-v1",
        netPaise: asPaise(9_000),
        cashTaxRateBps: 1_800,
        stressEligible: true,
      },
      {
        id: "outbound-logistics",
        kind: "outbound_shipping",
        sourceVersion: "sim-rate-card-v1",
        netPaise: asPaise(2_500),
        cashTaxRateBps: 1_800,
        stressEligible: true,
      },
      {
        id: "packing",
        kind: "packing_handling",
        sourceVersion: "sim-pack-v1",
        netPaise: asPaise(2_000),
        cashTaxRateBps: 1_800,
        stressEligible: false,
      },
    ],
    outcomes: [
      {
        kind: "kept",
        probabilityPpm: 870_000,
      },
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

export function runLocalEndToEndDemo(
  database: DatabaseSync,
): DemoSummary {
  initializeRuntimeSafety(database, T0);
  seedCommercialFixture(database);

  const sourceOffer = database
    .prepare(
      `
        SELECT id
        FROM source_offers
        WHERE supplier_id = 'supplier-1'
          AND supplier_sku = 'ACME-SKU-001'
      `,
    )
    .get() as { id: string };

  const economics = evaluateCandidate(underwritingScenario());
  const freshness = evaluateLatestSourceOffer(
    database,
    "supplier-1",
    "ACME-SKU-001",
    "2026-10-07T00:10:00.000Z",
    { maximumObservationAgeSeconds: 900 },
  );

  const opportunityId = persistOpportunity(database, {
    productId: "product-1",
    tradeUnitId: "trade-unit-1",
    sourceOfferId: sourceOffer.id,
    marketplace: "SIM",
    approvedPricePaise: 79_900,
    sourceFreshUntil: "2026-10-07T00:20:00.000Z",
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
    evidenceVersion: "demo-evidence-v1",
    createdAt: "2026-10-07T00:10:00.000Z",
  });

  const opportunity = database
    .prepare(
      "SELECT decision_state FROM opportunities WHERE id = ?",
    )
    .get(opportunityId) as { decision_state: string };

  if (opportunity.decision_state !== "LIST") {
    throw new Error("Demo opportunity did not reach LIST.");
  }

  recordVerifiedCashSnapshot(
    database,
    200_000,
    "demo-bank-balance",
    "2026-10-07T00:10:00.000Z",
    "2026-10-07T01:00:00.000Z",
  );
  setCashReservePolicy(
    database,
    20_000,
    20_000,
    "2026-10-07T00:10:00.000Z",
  );

  setStopNewExposure(
    database,
    false,
    "DEMO_RECONCILED",
    "2026-10-07T00:10:30.000Z",
  );

  const listingId = syncListingToSimulatedMarketplace(database, {
    marketplace: "SIM",
    sellerSku: "COSMO-ACME-001",
    marketplaceCatalogueItemId: "market-item-1",
    opportunityId,
    sourceOfferId: sourceOffer.id,
    pricePaise: 79_900,
    requestedQuantity: 1,
    updatedAt: "2026-10-07T00:11:00.000Z",
  });

  const orderId = ingestMarketplaceOrder(database, {
    marketplace: "SIM",
    marketplaceOrderId: "SIM-ORDER-001",
    marketplaceItemId: "SIM-ORDER-001-ITEM-1",
    sellerSku: "COSMO-ACME-001",
    quantity: 1,
    acceptedPricePaise: 79_900,
    receivedAt: "2026-10-07T00:12:00.000Z",
    economicsSnapshot: economics.base,
  });

  validateAndAuthorizeOrder(database, {
    orderId,
    sourceOfferId: sourceOffer.id,
    authorizedAt: "2026-10-07T00:12:30.000Z",
  });

  const poId = recordPurchaseIntent(database, {
    orderId,
    destinationKey: "SIM-CUSTOMER-DESTINATION",
    authorizationExpiresAt: "2026-10-07T00:18:00.000Z",
    createdAt: "2026-10-07T00:13:00.000Z",
  });

  const supplier = new SimulatedSupplierPurchaseAdapter(
    ":memory:",
    "CONFIRM",
  );
  try {
    submitPurchaseOnce(
      database,
      poId,
      supplier,
      "2026-10-07T00:13:30.000Z",
    );
  } finally {
    supplier.close();
  }

  confirmPack(
    database,
    orderId,
    "4006381333931",
    "SIM-BARCODE-SCAN-001",
    "SIM-LABEL-001",
    "SIM-CARRIER",
    "SIM-TRACK-001",
    "2026-10-07T00:20:00.000Z",
  );

  confirmCarrierHandover(
    database,
    orderId,
    "SIM-HANDOVER-EVIDENCE-001",
    "2026-10-07T00:30:00.000Z",
  );

  markInTransit(
    database,
    orderId,
    "2026-10-07T01:00:00.000Z",
  );

  markShipmentOutcome(
    database,
    orderId,
    "DELIVERED",
    "2026-10-08T10:00:00.000Z",
    "2026-10-20T00:00:00.000Z",
  );

  const profit = reconcileDeliveredKeptOrder(database, {
    orderId,
    customerRevenuePaise: 67_712,
    marketplaceFeePaise: 10_000,
    logisticsPaise: 2_500,
    supplierPayablePaise: 30_509,
    packingPaise: 2_000,
    overheadPaise: 1_200,
    expectedSettlementCashPaise: 64_750,
    settlementCashPaise: 64_750,
    marketplaceStatementRef: "SIM-STATEMENT-001",
    supplierInvoiceRef: "SIM-SUPPLIER-INVOICE-001",
    bankEvidenceRef: "SIM-BANK-SETTLEMENT-001",
    settledAt: "2026-10-20T00:00:00.000Z",
  });

  const order = database
    .prepare("SELECT state FROM orders WHERE id = ?")
    .get(orderId) as { state: string };
  const listing = database
    .prepare(
      `
        SELECT observed_state, observed_quantity
        FROM listings
        WHERE id = ?
      `,
    )
    .get(listingId) as {
    observed_state: string;
    observed_quantity: bigint;
  };
  const purchase = database
    .prepare("SELECT state FROM purchase_orders WHERE id = ?")
    .get(poId) as { state: string };
  const shipment = database
    .prepare("SELECT state FROM shipments WHERE order_id = ?")
    .get(orderId) as { state: string };
  const audit = database
    .prepare("SELECT COUNT(*) AS count FROM audit_events")
    .get() as { count: bigint };

  return {
    orderId,
    finalOrderState: order.state,
    opportunityState: opportunity.decision_state,
    listingState: listing.observed_state,
    listingQuantity: listing.observed_quantity,
    purchaseState: purchase.state,
    shipmentState: shipment.state,
    recognizedProfitPaise: profit,
    auditEventCount: audit.count,
  };
}
