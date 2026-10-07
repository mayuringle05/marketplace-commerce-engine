import type { DatabaseSync } from "node:sqlite";

import { deterministicId } from "../core/deterministic.ts";
import {
  transitionOrder,
  type OrderState,
} from "../orders/state-machine.ts";

export function openReturn(
  database: DatabaseSync,
  orderId: string,
  marketplaceReturnId: string,
  refundPaise: number,
  openedAt: string,
): string {
  if (!Number.isSafeInteger(refundPaise) || refundPaise < 0) {
    throw new Error("Refund must be a non-negative integer.");
  }

  const order = database
    .prepare("SELECT state, version FROM orders WHERE id = ?")
    .get(orderId) as
    | { state: OrderState; version: bigint }
    | undefined;

  if (
    order === undefined ||
    (order.state !== "DELIVERED" &&
      order.state !== "MATURED")
  ) {
    throw new Error(
      "Return can only open from DELIVERED or MATURED.",
    );
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
            updated_at,
            receipt_evidence_ref,
            recovery_evidence_ref
          ) VALUES (?, ?, ?, 'OPEN', ?, 0, NULL, ?, ?, NULL, NULL)
          ON CONFLICT(marketplace_return_id) DO NOTHING
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

    const persisted = database
      .prepare(
        `
          SELECT order_id, refund_paise
          FROM returns
          WHERE marketplace_return_id = ?
        `,
      )
      .get(marketplaceReturnId) as {
      order_id: string;
      refund_paise: bigint;
    };

    if (
      persisted.order_id !== orderId ||
      persisted.refund_paise !== BigInt(refundPaise)
    ) {
      throw new Error("Conflicting return replay.");
    }

    transitionOrder(
      database,
      orderId,
      order.state,
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

export function markReturnReceived(
  database: DatabaseSync,
  returnId: string,
  receiptEvidenceRef: string,
  receivedAt: string,
): void {
  if (receiptEvidenceRef.trim().length === 0) {
    throw new Error("Return receipt evidence is required.");
  }

  const result = database
    .prepare(
      `
        UPDATE returns
        SET
          state = 'RECEIVED',
          receipt_evidence_ref = ?,
          updated_at = ?
        WHERE id = ?
          AND state IN ('OPEN', 'IN_TRANSIT')
      `,
    )
    .run(receiptEvidenceRef, receivedAt, returnId);

  if (result.changes !== 1n) {
    throw new Error("Return is not awaiting receipt.");
  }
}

export function gradeAndCloseReturn(
  database: DatabaseSync,
  returnId: string,
  grade: string,
  recoveryPaise: number,
  recoveryEvidenceRef: string | null,
  closedAt: string,
): void {
  if (grade.trim().length === 0) {
    throw new Error("Return grade is required.");
  }
  if (!Number.isSafeInteger(recoveryPaise) || recoveryPaise < 0) {
    throw new Error("Recovery must be a non-negative integer.");
  }
  if (
    recoveryPaise > 0 &&
    (recoveryEvidenceRef === null ||
      recoveryEvidenceRef.trim().length === 0)
  ) {
    throw new Error(
      "Positive realized recovery requires recovery evidence.",
    );
  }

  const result = database
    .prepare(
      `
        UPDATE returns
        SET
          state = 'CLOSED',
          grade = ?,
          recovery_paise = ?,
          recovery_evidence_ref = ?,
          updated_at = ?
        WHERE id = ?
          AND state IN ('RECEIVED', 'GRADED', 'CREDIT_PENDING')
          AND receipt_evidence_ref IS NOT NULL
      `,
    )
    .run(
      grade,
      recoveryPaise,
      recoveryEvidenceRef,
      closedAt,
      returnId,
    );

  if (result.changes !== 1n) {
    throw new Error(
      "Return must be physically received before grading/closure.",
    );
  }
}
