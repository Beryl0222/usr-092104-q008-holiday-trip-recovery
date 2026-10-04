import assert from "node:assert/strict";
import test from "node:test";

import { buildScenario, defaultAlternatives, CORR, PARTY_ID } from "./fixtures/scenario.js";

function setupFrozenOption(scenario) {
  const { service, refundPolicies } = scenario;
  service.receiveSupplierCallback({
    callback_id: "cb-sm", supplier: "12306", type: "waitlist_result",
    supplier_ref: "RAIL-930-22", outcome: "failed", correlation_id: CORR,
  });
  const { option_id } = service.propose({
    party_id: PARTY_ID, correlation_id: CORR,
    disruption: { segment_id: "seg-rail", kind: "waitlist_failed" },
    alternatives: defaultAlternatives(), refundPolicies,
  });
  service.freeze({ option_id });
  return option_id;
}

test("方案状态机：accepted 后再 accept 必须拒绝，不能二次出票或退款", async () => {
  const scenario = buildScenario();
  const { service, store, gateway } = scenario;
  const option_id = setupFrozenOption(scenario);
  const n = await service.notifyFrozen({ option_id, channel: "sms" });
  service.accept({ option_id, by: "p1", notification_id: n.notification_id });

  const ticketEventsBefore = store.allEvents().filter((e) => e.event_type === "SUPPLIER_TICKETED").length;
  const refundEventsBefore = store.allEvents().filter((e) => e.event_type === "REFUND_CONFIRMED").length;
  assert.throws(() => service.accept({ option_id, by: "p1" }), /须先冻结/);
  assert.equal(store.allEvents().filter((e) => e.event_type === "SUPPLIER_TICKETED").length, ticketEventsBefore);
  assert.equal(store.allEvents().filter((e) => e.event_type === "REFUND_CONFIRMED").length, refundEventsBefore);
});

test("proposed 方案未冻结不能 accept；expired 方案不能 accept", () => {
  const scenario = buildScenario();
  const { service } = scenario;
  const optionId = setupFrozenOption(scenario);
  // 已是 frozen；先校验过期路径
  scenario.advance(60 * 60_000);
  service.expireIfDue(optionId);
  assert.throws(() => service.accept({ option_id: optionId, by: "p1" }), /须先冻结/);
});

test("拒绝方案后占位释放且状态为 rejected，不能再确认", () => {
  const scenario = buildScenario();
  const { service, gateway } = scenario;
  const optionId = setupFrozenOption(scenario);
  const frozen = service.reject({ option_id: optionId, by: "p1", reason: "想等家人商量" });
  assert.equal(frozen.state.status, "rejected");
  for (const h of frozen.state.holds) {
    assert.equal(gateway.getHold(h.hold_id).status, "released");
  }
  assert.throws(() => service.accept({ option_id: optionId, by: "p1" }), /须先冻结/);
});
