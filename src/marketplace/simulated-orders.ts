import type { DatabaseSync } from "node:sqlite";

export type SimulatedMarketplaceOrderStatus =
  | "ACCEPTED"
  | "HELD"
  | "CANCELLED";

export function setSimulatedMarketplaceOrderStatus(
  database: DatabaseSync,
  marketplace: string,
  marketplaceOrderId: string,
  status: SimulatedMarketplaceOrderStatus,
  updatedAt: string,
): void {
  const result = database
    .prepare(
      `
        UPDATE simulated_marketplace_orders
        SET status = ?, updated_at = ?
        WHERE marketplace = ?
          AND marketplace_order_id = ?
      `,
    )
    .run(status, updatedAt, marketplace, marketplaceOrderId);

  if (result.changes !== 1n) {
    throw new Error("Simulated marketplace order not found.");
  }
}
