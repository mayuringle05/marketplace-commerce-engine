import assert from "node:assert/strict";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import {
  reconcileUnknownPurchase,
  recordPurchaseIntent,
  submitPurchaseOnce,
} from "./service.ts";
import {
  recordRecoveredSimulatedPurchase,
} from "../supplier/simulated-purchase.ts";

const T = "2026-10-07T00:00:00.000Z";

function seedAuthorizedOrder(
  database: ReturnType<typeof openDatabase>,
): void {
  database
    .prepare(
      `
        INSERT INTO suppliers (
          id,
          legal_name,
          status,
          created_at,
          updated_at
        ) VALUES ('supplier-1', 'Supplier One', 'verified', ?, ?)
      `,
    )
    .run(T, T);

  database
    .prepare(
      `
        INSERT INTO orders (
          id,
          marketplace,
          marketplace_order_id,
          state,
          version,
          received_at,
          updated_at,
          immutable_economics_json
        ) VALUES (
          'order-1',
          'SIM',
          'REMOTE-1',
          'AUTHORIZED',
          1,
          ?,
          ?,
          '{}'
        )
      `,
    )
    .run(T, T);

  database
    .prepare(
      `
        INSERT INTO simulated_marketplace_orders (
          marketplace,
          marketplace_order_id,
          status,
          updated_at
        ) VALUES ('SIM', 'REMOTE-1', 'ACCEPTED', ?)
      `,
    )
    .run(T);
}

test("unknown purchase is quarantined and cannot be blindly resubmitted", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T,
  });

  try {
    seedAuthorizedOrder(database);

    const poId = recordPurchaseIntent(database, {
      orderId: "order-1",
      supplierId: "supplier-1",
      amountPaise: 35_000,
      quantity: 1,
      destinationKey: "DEST-1",
      authorizationExpiresAt: "2026-10-07T00:06:00.000Z",
      createdAt: "2026-10-07T00:01:00.000Z",
    });

    submitPurchaseOnce(
      database,
      poId,
      "UNKNOWN",
      "2026-10-07T00:02:00.000Z",
    );

    const order = database
      .prepare("SELECT state FROM orders WHERE id = 'order-1'")
      .get() as { state: string };
    const po = database
      .prepare(
        `
          SELECT
            state,
            idempotency_key,
            client_po_ref,
            authorized_amount_paise,
            quantity
          FROM purchase_orders
          WHERE id = ?
        `,
      )
      .get(poId) as {
      state: string;
      idempotency_key: string;
      client_po_ref: string;
      authorized_amount_paise: bigint;
      quantity: bigint;
    };
    const exception = database
      .prepare(
        `
          SELECT state, exposure_reserved, safe_next_action
          FROM exceptions
          WHERE order_id = 'order-1'
        `,
      )
      .get() as {
      state: string;
      exposure_reserved: bigint;
      safe_next_action: string;
    };

    assert.equal(order.state, "PAYMENT_UNKNOWN");
    assert.equal(po.state, "PURCHASE_UNKNOWN");
    assert.equal(exception.state, "OPEN");
    assert.equal(exception.exposure_reserved, 1n);
    assert.match(exception.safe_next_action, /do not resubmit/i);

    assert.throws(
      () =>
        submitPurchaseOnce(
          database,
          poId,
          "CONFIRM",
          "2026-10-07T00:03:00.000Z",
        ),
      /not ready for first submission/,
    );

    recordRecoveredSimulatedPurchase(
      database,
      {
        idempotencyKey: po.idempotency_key,
        clientPoRef: po.client_po_ref,
        amountPaise: Number(po.authorized_amount_paise),
        quantity: Number(po.quantity),
        submittedAt: "2026-10-07T00:02:00.000Z",
      },
      "CONFIRMED",
    );

    assert.equal(
      reconcileUnknownPurchase(
        database,
        poId,
        "2026-10-07T00:04:00.000Z",
      ),
      true,
    );

    const recoveredOrder = database
      .prepare("SELECT state FROM orders WHERE id = 'order-1'")
      .get() as { state: string };
    const recoveredPo = database
      .prepare("SELECT state FROM purchase_orders WHERE id = ?")
      .get(poId) as { state: string };
    const resolvedException = database
      .prepare(
        `
          SELECT state
          FROM exceptions
          WHERE order_id = 'order-1'
        `,
      )
      .get() as { state: string };
    const remoteCount = database
      .prepare(
        "SELECT COUNT(*) AS count FROM simulated_supplier_orders",
      )
      .get() as { count: bigint };

    assert.equal(recoveredOrder.state, "PO_CONFIRMED");
    assert.equal(recoveredPo.state, "CONFIRMED");
    assert.equal(resolvedException.state, "RESOLVED");
    assert.equal(remoteCount.count, 1n);
  } finally {
    database.close();
  }
});

test("expired purchase authorization cannot submit a supplier order", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T,
  });

  try {
    database
      .prepare(
        `
          INSERT INTO suppliers (
            id,
            legal_name,
            status,
            created_at,
            updated_at
          ) VALUES ('supplier-expiry', 'Supplier Expiry', 'verified', ?, ?)
        `,
      )
      .run(T, T);

    database
      .prepare(
        `
          INSERT INTO orders (
            id,
            marketplace,
            marketplace_order_id,
            state,
            version,
            received_at,
            updated_at,
            immutable_economics_json
          ) VALUES (
            'order-expiry',
            'SIM',
            'REMOTE-EXPIRY',
            'AUTHORIZED',
            1,
            ?,
            ?,
            '{}'
          )
        `,
      )
      .run(T, T);

    database
      .prepare(
        `
          INSERT INTO simulated_marketplace_orders (
            marketplace,
            marketplace_order_id,
            status,
            updated_at
          ) VALUES ('SIM', 'REMOTE-EXPIRY', 'ACCEPTED', ?)
        `,
      )
      .run(T);

    const poId = recordPurchaseIntent(database, {
      orderId: "order-expiry",
      supplierId: "supplier-expiry",
      amountPaise: 35_000,
      quantity: 1,
      destinationKey: "DEST",
      authorizationExpiresAt: "2026-10-07T00:02:00.000Z",
      createdAt: "2026-10-07T00:01:00.000Z",
    });

    assert.throws(
      () =>
        submitPurchaseOnce(
          database,
          poId,
          "CONFIRM",
          "2026-10-07T00:02:01.000Z",
        ),
      /authorization has expired/,
    );

    const remote = database
      .prepare(
        "SELECT COUNT(*) AS count FROM simulated_supplier_orders",
      )
      .get() as { count: bigint };
    assert.equal(remote.count, 0n);
  } finally {
    database.close();
  }
});

test("customer cancellation before supplier submission blocks purchase", () => {
  const database = openDatabase(":memory:", {
    appliedAt: T,
  });

  try {
    seedAuthorizedOrder(database);

    const poId = recordPurchaseIntent(database, {
      orderId: "order-1",
      supplierId: "supplier-1",
      amountPaise: 35_000,
      quantity: 1,
      destinationKey: "DEST-1",
      authorizationExpiresAt: "2026-10-07T00:06:00.000Z",
      createdAt: "2026-10-07T00:01:00.000Z",
    });

    database
      .prepare(
        `
          UPDATE simulated_marketplace_orders
          SET status = 'CANCELLED',
              updated_at = '2026-10-07T00:01:30.000Z'
          WHERE marketplace = 'SIM'
            AND marketplace_order_id = 'REMOTE-1'
        `,
      )
      .run();

    assert.throws(
      () =>
        submitPurchaseOnce(
          database,
          poId,
          "CONFIRM",
          "2026-10-07T00:02:00.000Z",
        ),
      /not ACCEPTED/,
    );

    const remote = database
      .prepare(
        "SELECT COUNT(*) AS count FROM simulated_supplier_orders",
      )
      .get() as { count: bigint };
    const po = database
      .prepare("SELECT state FROM purchase_orders WHERE id = ?")
      .get(poId) as { state: string };

    assert.equal(remote.count, 0n);
    assert.equal(po.state, "INTENT_RECORDED");
  } finally {
    database.close();
  }
});
