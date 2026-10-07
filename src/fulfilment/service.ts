import type { DatabaseSync } from "node:sqlite";

import { deterministicId } from "../core/deterministic.ts";
import {
  normalizeIdentifier,
  type IdentifierType,
} from "../identity/identifiers.ts";
import {
  transitionOrder,
  type OrderState,
} from "../orders/state-machine.ts";

interface OrderRow {
  readonly state: OrderState;
  readonly version: bigint;
}

function orderRow(
  database: DatabaseSync,
  orderId: string,
): OrderRow {
  const row = database
    .prepare("SELECT state, version FROM orders WHERE id = ?")
    .get(orderId) as OrderRow | undefined;
  if (row === undefined) {
    throw new Error("Order not found.");
  }
  return row;
}

export function confirmPack(
  database: DatabaseSync,
  orderId: string,
  scannedBarcode: string,
  scanEvidenceRef: string,
  labelRef: string,
  carrier: string,
  trackingNumber: string,
  at: string,
): string {
  if (
    scannedBarcode.trim().length === 0 ||
    scanEvidenceRef.trim().length === 0
  ) {
    throw new Error(
      "Pack confirmation requires scanned barcode and scan evidence.",
    );
  }
  if (labelRef.length === 0 || trackingNumber.length === 0) {
    throw new Error("Label and tracking number are required.");
  }

  const order = orderRow(database, orderId);
  if (order.state !== "PO_CONFIRMED") {
    throw new Error("Pack confirmation requires PO_CONFIRMED order.");
  }

  const po = database
    .prepare(
      "SELECT id FROM purchase_orders WHERE order_id = ? AND state = 'CONFIRMED'",
    )
    .get(orderId) as { id: string } | undefined;
  if (po === undefined) {
    throw new Error("Confirmed purchase order not found.");
  }

  const identity = database
    .prepare(
      `
        SELECT
          t.barcode_type,
          t.barcode_value,
          t.mapping_status AS trade_mapping_status,
          t.physical_verified_at,
          m.mapping_status AS marketplace_mapping_status
        FROM order_items i
        JOIN packaged_trade_units t
          ON t.id = i.trade_unit_id
        JOIN listings l
          ON l.id = i.listing_id
        JOIN marketplace_catalogue_items m
          ON m.id = l.marketplace_catalogue_item_id
        WHERE i.order_id = ?
      `,
    )
    .all(orderId) as Array<{
    barcode_type: string | null;
    barcode_value: string | null;
    trade_mapping_status: string;
    physical_verified_at: string | null;
    marketplace_mapping_status: string;
  }>;

  if (
    identity.length !== 1 ||
    identity[0] === undefined ||
    identity[0].barcode_type === null ||
    identity[0].barcode_value === null ||
    identity[0].trade_mapping_status !== "APPROVED" ||
    identity[0].marketplace_mapping_status !== "APPROVED" ||
    identity[0].physical_verified_at === null
  ) {
    throw new Error(
      "Pack blocked by missing or invalidated immutable identity evidence.",
    );
  }

  const normalized = normalizeIdentifier(
    identity[0].barcode_type as IdentifierType,
    scannedBarcode,
  );
  if (
    !normalized.valid ||
    normalized.normalized !== identity[0].barcode_value
  ) {
    throw new Error("Scanned barcode does not match the ordered trade unit.");
  }

  const shipmentId = deterministicId("shipment", orderId);

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `
          INSERT INTO shipments (
            id,
            order_id,
            purchase_order_id,
            carrier,
            tracking_number,
            state,
            label_ref,
            handover_evidence_ref,
            created_at,
            updated_at,
            scanned_barcode,
            scan_evidence_ref
          ) VALUES (
            ?, ?, ?, ?, ?, 'PACK_CONFIRMED', ?, NULL, ?, ?, ?, ?
          )
        `,
      )
      .run(
        shipmentId,
        orderId,
        po.id,
        carrier,
        trackingNumber,
        labelRef,
        at,
        at,
        normalized.normalized,
        scanEvidenceRef,
      );

    transitionOrder(
      database,
      orderId,
      "PO_CONFIRMED",
      Number(order.version),
      "PACK_CONFIRMED",
      at,
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return shipmentId;
}

export function confirmCarrierHandover(
  database: DatabaseSync,
  orderId: string,
  handoverEvidenceRef: string,
  at: string,
): void {
  if (handoverEvidenceRef.length === 0) {
    throw new Error("Carrier handover evidence is required.");
  }

  const order = orderRow(database, orderId);
  if (order.state !== "PACK_CONFIRMED") {
    throw new Error("Handover requires PACK_CONFIRMED order.");
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const result = database
      .prepare(
        `
          UPDATE shipments
          SET
            state = 'HANDOVER_CONFIRMED',
            handover_evidence_ref = ?,
            updated_at = ?
          WHERE order_id = ?
            AND state = 'PACK_CONFIRMED'
        `,
      )
      .run(handoverEvidenceRef, at, orderId);

    if (result.changes !== 1n) {
      throw new Error("Shipment is not ready for handover.");
    }

    transitionOrder(
      database,
      orderId,
      "PACK_CONFIRMED",
      Number(order.version),
      "HANDOVER_CONFIRMED",
      at,
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function markInTransit(
  database: DatabaseSync,
  orderId: string,
  at: string,
): void {
  const order = orderRow(database, orderId);
  if (order.state !== "HANDOVER_CONFIRMED") {
    throw new Error("Transit requires HANDOVER_CONFIRMED order.");
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `
          UPDATE shipments
          SET state = 'IN_TRANSIT', updated_at = ?
          WHERE order_id = ?
            AND state = 'HANDOVER_CONFIRMED'
        `,
      )
      .run(at, orderId);

    transitionOrder(
      database,
      orderId,
      "HANDOVER_CONFIRMED",
      Number(order.version),
      "IN_TRANSIT",
      at,
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function markShipmentOutcome(
  database: DatabaseSync,
  orderId: string,
  outcome: "DELIVERED" | "RTO" | "LOST" | "DAMAGED",
  at: string,
): void {
  const order = orderRow(database, orderId);
  if (order.state !== "IN_TRANSIT") {
    throw new Error("Shipment outcome requires IN_TRANSIT order.");
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `
          UPDATE shipments
          SET state = ?, updated_at = ?
          WHERE order_id = ?
            AND state = 'IN_TRANSIT'
        `,
      )
      .run(outcome, at, orderId);

    transitionOrder(
      database,
      orderId,
      "IN_TRANSIT",
      Number(order.version),
      outcome,
      at,
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
