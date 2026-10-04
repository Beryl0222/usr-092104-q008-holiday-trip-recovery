import assert from "node:assert/strict";
import test from "node:test";

import { SupplierGateway, SupplierError } from "../src/suppliers/gateway.js";

const now = () => new Date("2026-10-01T00:00:00Z");

test("出站请求按幂等键记忆：重复占位/出票/退款只生效一次", () => {
  const gw = new SupplierGateway({ now });
  gw.registerBooking({ supplier_ref: "PNR-1", supplier: "air", kind: "domestic_air", amount: 100, currency: "CNY" });

  const h1 = gw.placeHold({ supplier: "air", kind: "domestic_air", passengers: ["p1"], amount: 100, currency: "CNY", ttlMs: 60_000, idempotencyKey: "k-hold" });
  assert.equal(h1.replayed, false);
  const h2 = gw.placeHold({ supplier: "air", kind: "domestic_air", passengers: ["p1"], amount: 100, currency: "CNY", ttlMs: 60_000, idempotencyKey: "k-hold" });
  assert.equal(h2.replayed, true);
  assert.equal(h2.hold.hold_id, h1.hold.hold_id, "重复占位返回同一 hold_id，不二次占位");

  const t1 = gw.ticketHold({ hold_id: h1.hold.hold_id, idempotencyKey: "k-ticket" });
  const t2 = gw.ticketHold({ hold_id: h1.hold.hold_id, idempotencyKey: "k-ticket" });
  assert.equal(t2.replayed, true);
  assert.equal(t2.supplier_ref, t1.supplier_ref);

  const r1 = gw.requestRefund({ supplier_ref: "PNR-1", idempotencyKey: "k-refund" });
  const r2 = gw.requestRefund({ supplier_ref: "PNR-1", idempotencyKey: "k-refund" });
  assert.equal(r2.replayed, true);
  assert.equal(r2.refund_id, r1.refund_id);
});

test("入站回调按 callback_id 去重，处理器只执行一次", () => {
  const gw = new SupplierGateway({ now });
  let calls = 0;
  const cb = { callback_id: "cb-1", supplier: "air", type: "disruption", supplier_ref: "PNR-1" };
  const a = gw.ingestCallback(cb, () => {
    calls += 1;
    return { applied: true };
  });
  const b = gw.ingestCallback(cb, () => {
    calls += 1;
    return { applied: true };
  });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(calls, 1, "重复回调的副作用处理器不得第二次执行");
});

test("缺少幂等键直接拒绝，防止裸重试", () => {
  const gw = new SupplierGateway({ now });
  assert.throws(
    () => gw.placeHold({ supplier: "air", kind: "domestic_air", passengers: ["p1"], amount: 1, currency: "CNY", ttlMs: 1000 }),
    (e) => e.code === "IDEMPOTENCY_KEY_REQUIRED"
  );
});

test("承诺锁价：出票时现价变动仍按承诺价结算", () => {
  const gw = new SupplierGateway({ now });
  gw.setCurrentPrice("air", 999);
  const quote = gw.quotePrice({ supplier: "air", amount: 500, currency: "CNY", ttlMs: 60_000, idempotencyKey: "q1" });
  const hold = gw.placeHold({
    supplier: "air", kind: "domestic_air", passengers: ["p1"], amount: 999, currency: "CNY",
    ttlMs: 60_000, idempotencyKey: "h1", commitment_id: quote.commitment_id,
  });
  assert.equal(hold.hold.amount, 500);
  assert.deepEqual(hold.price_changed, { from: 999, to: 500 });
});

test("过期承诺不能用于占位", () => {
  let t = new Date("2026-10-01T00:00:00Z").getTime();
  const gw = new SupplierGateway({ now: () => new Date(t) });
  const quote = gw.quotePrice({ supplier: "air", amount: 1, currency: "CNY", ttlMs: 1000, idempotencyKey: "q1" });
  t += 2000;
  assert.throws(
    () => gw.placeHold({ supplier: "air", kind: "domestic_air", passengers: ["p1"], amount: 1, currency: "CNY", ttlMs: 1000, idempotencyKey: "h1", commitment_id: quote.commitment_id }),
    (e) => e.code === "COMMITMENT_EXPIRED"
  );
});

test("同一订单可多笔部分退款，但全额退款后再退被拒", () => {
  const gw = new SupplierGateway({ now });
  gw.registerBooking({ supplier_ref: "PNR-9", supplier: "air", kind: "overseas_air", amount: 900, currency: "CNY" });
  gw.requestRefund({ supplier_ref: "PNR-9", amount: 300, currency: "CNY", idempotencyKey: "r1", partial: true });
  gw.requestRefund({ supplier_ref: "PNR-9", amount: 600, currency: "CNY", idempotencyKey: "r2", partial: true });
  assert.throws(
    () => gw.requestRefund({ supplier_ref: "PNR-9", amount: 1, currency: "CNY", idempotencyKey: "r3" }),
    (e) => e instanceof SupplierError
  );
});
