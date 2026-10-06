import type { DatabaseSync } from "node:sqlite";

import { deterministicId } from "../core/deterministic.ts";
import { transitionOrder } from "../orders/state-machine.ts";

export function openReturn(
  database: DatabaseSync,
  orderId: string,
  marketplaceReturnId: string,
  refundPaise: number,
  openedAt: string,
): string {
  const order = database
    .prepare("SELECT state, version FROM orders WHERE id = ?")
    .get(orderId) as
    | { state: string; version: bigint }
    | undefined;

  if (order === undefined || order.state !== "DELIVERED") {
    throw new Error("Return can only open from DELIVERED.");
  }

  const id = deterministicId(
    "return",
    orderId,
    marketplaceReturnId,
  );

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `
          INSERT INTO returns (
            id,
            order_id,
            marketplace_return_id,
            state,
            refund_paise,
            recovery_paise,
            grade,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, 'OPEN', ?, 0, NULL, ?, ?)
        `,
      )
      .run(
        id,
        orderId,
        marketplaceReturnId,
        refundPaise,
        openedAt,
        openedAt,
      );

    transitionOrder(
      database,
      orderId,
      "DELIVERED",
      Number(order.version),
      "RETURN_OPEN",
      openedAt,
    );

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return id;
}

export function gradeAndCloseReturn(
  database: DatabaseSync,
  returnId: string,
  grade: string,
  recoveryPaise: number,
  closedAt: string,
): void {
  if (!Number.isSafeInteger(recoveryPaise) || recoveryPaise < 0) {
    throw new Error("Recovery must be a non-negative integer.");
  }

  const result = database
    .prepare(
      `
        UPDATE returns
        SET
          state = 'CLOSED',
          grade = ?,
          recovery_paise = ?,
          updated_at = ?
        WHERE id = ?
          AND state IN ('OPEN', 'IN_TRANSIT', 'RECEIVED', 'GRADED', 'CREDIT_PENDING')
      `,
    )
    .run(grade, recoveryPaise, closedAt, returnId);

  if (result.changes !== 1n) {
    throw new Error("Return is not open for grading/closure.");
  }
}
