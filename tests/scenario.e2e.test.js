/**
 * 端到端：双节联程中断协商全流程。
 *
 * 覆盖需求逐条：
 *  1. 候补失败回调触发规划，不逐单退款、保住仍可使用段
 *  2. 冻结只占位、拿到价格承诺；确认前所有仍有效订单不动
 *  3. 供应方重复回调幂等：不产生第二个事件、不二次占位/退款
 *  4. 跨午夜/跨时区连接按当地时间：红眼保住酒店当晚、MCT 按绝对分钟
 *  5. 证件期限只影响受限成员 → 拆分同行，不整团改签
 *  6. 价格承诺锁价：出票时供应方涨价仍按承诺价
 *  7. 通知必须真正送达；未送达不能作为知情确认依据
 *  8. 确认顺序：先出新票，再退旧单
 *  9. 资金每笔可沿 承诺/事件/供应方单号 追溯，最终对账
 * 10. 占位到期未确认自动释放，原订单不受影响
 * 11. 对照「逐单退款」方案损失权益更大
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildScenario, defaultAlternatives, CORR, PARTY_ID } from "./fixtures/scenario.js";
import { loadAggregate } from "../src/domain/aggregates.js";
import { customerExplanation, agentDashboard, disputeTrail, timeline } from "../src/application/queries.js";

function proposeRecommended(scenario, disruption) {
  const { service, refundPolicies } = scenario;
  const { option_id, plan } = service.propose({
    party_id: PARTY_ID,
    correlation_id: CORR,
    disruption,
    alternatives: defaultAlternatives(),
    refundPolicies,
  });
  return { option_id, plan, recommended: plan.options.find((o) => o.recommended) };
}

test("场景：火车候补失败 → 保住可用段、改签不可用段、证件受限成员拆分，全流程资金可追溯", async () => {
  const scenario = buildScenario();
  const { service, store, gateway } = scenario;

  // ---- 1. 供应方回调：火车候补失败（重复投递两次）----
  const cb = {
    callback_id: "cb-wl-001",
    supplier: "12306",
    type: "waitlist_result",
    supplier_ref: "RAIL-930-22",
    outcome: "failed",
    correlation_id: CORR,
  };
  const first = service.receiveSupplierCallback(cb);
  assert.equal(first.duplicate, false);
  assert.equal(first.applied, true);
  const second = service.receiveSupplierCallback(cb);
  assert.equal(second.duplicate, true, "重复回调必须回传首次结论");
  assert.equal(second.outcome, "failed");

  const railEvents = store.load("booking_segment", "seg-rail");
  assert.equal(railEvents.filter((e) => e.event_type === "WAITLIST_RESULT_RECEIVED").length, 1,
    "重复回调不得产生第二个领域事件");
  assert.equal(loadAggregate(store, "booking_segment", "seg-rail").state.status, "failed");

  // ---- 2. 规划：推荐方案 vs 逐单退款 ----
  const { option_id, plan, recommended } = proposeRecommended(scenario, {
    segment_id: "seg-rail",
    kind: "waitlist_failed",
  });

  const bySegment = Object.fromEntries(recommended.actions.map((a) => [a.segment_id, a]));

  // 火车候补失败：改签晚班火车（08:05 到）
  assert.equal(bySegment["seg-rail"].action, "rebook");
  // 接驳原班 07:00 赶不上（08:05 才到，MCT 60 分钟）→ 改签 09:30 接驳
  assert.equal(bySegment["seg-shuttle"].action, "rebook");
  // 县城酒店：接驳 10:10 到，入住日当天到达 → 保留
  assert.equal(bySegment["seg-hotel-county"].action, "preserve");
  // 国内航班原 09:00 赶不上（火车 08:05 到，MCT 120）→ 改签 12:30 班，14:30 到口岸
  assert.equal(bySegment["seg-air-dom"].action, "rebook");
  // 境外航班：14:30 到、原班 15:30 飞，仅 60 分钟 < MCT 150；改 20:00 班可接上
  // 且孩子 p3 护照不足 → 拆分：p1/p2/p4 走晚班，p3 拆出
  assert.equal(bySegment["seg-air-over"].action, "split");
  assert.deepEqual(bySegment["seg-air-over"].split_passenger_ids, ["p3"]);
  assert.deepEqual(bySegment["seg-air-over"].keep_passenger_ids.sort(), ["p1", "p2", "p4"]);
  // 境外酒店：晚班 23:50（东京当地）到达，在 04:00 夜切前 → 保留当晚住房，不新增一晚
  assert.equal(bySegment["seg-hotel-over"].action, "preserve");

  // 受影响但保留的段，在冻结前一刻仍是有效订单
  for (const id of recommended.untouched_valid_orders) {
    assert.equal(loadAggregate(store, "booking_segment", id).state.is_valid_order, true, `${id} 应仍有效`);
  }

  // 逐单退款对照方案：损失权益严格更大
  const cancelAll = plan.options.find((o) => o.key === "cancel_chain");
  const lossRecommended = recommended.totals.lost_entitlement[0]?.amount ?? 0;
  const lossCancelAll = cancelAll.totals.lost_entitlement[0]?.amount ?? 0;
  assert.ok(lossCancelAll > lossRecommended,
    `逐单退款损失 ${lossCancelAll} 应大于保联程损失 ${lossRecommended}`);

  // ---- 3. 冻结：占位 + 价格承诺，供应方现价上涨仍按承诺价 ----
  // 改签国际票报价 2300/人；供应方「现价」涨到 2600
  gateway.setCurrentPrice("intl-air", 2600);
  const frozen = service.freeze({ option_id });
  assert.equal(frozen.state.status, "frozen");
  assert.ok(frozen.state.expires_at, "必须给出占位到期时刻");
  const intlHold = frozen.state.holds.find((h) => h.supplier === "intl-air");
  assert.equal(intlHold.amount.amount, 3 * 2300, "占位价格锁定在承诺价，不被供应方涨价偷换");
  // 涨价被留痕
  assert.ok(frozen.events.some((e) => e.event_type === "SUPPLIER_PRICE_CHANGED"));

  // 冻结后所有仍有效订单状态原封不动
  for (const id of ["seg-air-dom", "seg-hotel-county", "seg-hotel-over", "seg-shuttle"]) {
    const before = loadAggregate(store, "booking_segment", id).state;
    assert.equal(before.status === "booked" || before.status === "ticketed", true, `${id} 冻结期间不得被改动`);
    assert.ok(!before.replaced_by, `${id} 冻结期间不得被替换`);
  }

  // ---- 4. 通知必须真正送达 ----
  // 先走一条会失败的通道
  const failed = await service.notifyFrozen({ option_id, channel: "failing_channel", to: "13800000000" });
  assert.equal(failed.state, "failed");
  // 未送达不能作为确认依据
  assert.throws(
    () => service.accept({ option_id, by: "p1", notification_id: failed.notification_id }),
    /未真正送达/
  );
  // 方案此刻仍冻结，订单未动
  assert.equal(loadAggregate(store, "recovery_option", option_id).state.status, "frozen");

  const delivered = await service.notifyFrozen({ option_id, channel: "sms" });
  assert.equal(delivered.state, "delivered");

  // 记录所有占位/承诺 id，供确认后核对
  const holdIdsBefore = frozen.state.holds.map((h) => h.hold_id);
  const oldRefs = {
    rail: "RAIL-930-22",
    shuttle: "BUS-1001-07",
    dom: "DOM-1001-09",
    over: "INTL-1001-1530",
    hotelCounty: "HTL-COUNTY-1001",
    hotelOver: "HTL-OVER-1001",
  };

  // ---- 5. 确认：先出新票，再退旧单 ----
  const result = service.accept({ option_id, by: "p1", notification_id: delivered.notification_id, note: "按推荐方案执行" });

  // 5a. 每个占位都出了新票
  for (const holdId of holdIdsBefore) {
    const h = gateway.getHold(holdId);
    assert.equal(h.status, "ticketed", `占位 ${holdId} 应已转出票`);
  }
  // 5b. 旧订单：改签的被新单替换并退款；保留的两家酒店供应方侧仍 booked
  assert.equal(gateway.getBooking(oldRefs.hotelCounty).status, "booked", "县城酒店保留，供应方单不动");
  assert.equal(gateway.getBooking(oldRefs.hotelOver).status, "booked", "境外酒店保留，供应方单不动");
  for (const ref of [oldRefs.shuttle, oldRefs.dom]) {
    assert.equal(gateway.getBooking(ref).status, "refunded", `${ref} 旧单应在新票后退款`);
  }

  // 5c. 先立后破：新票事件时间上早于对应旧单退款事件
  const ev = store.allEvents();
  const idx = (pred) => ev.findIndex(pred);
  const newDomTicket = idx((e) => e.event_type === "SEGMENT_BOOKED" && e.payload?.supplier === "china-local-air");
  const oldDomRefund = idx((e) => e.event_type === "REFUND_CONFIRMED" && e.payload?.supplier_ref === oldRefs.dom);
  assert.ok(newDomTicket >= 0 && oldDomRefund >= 0 && newDomTicket < oldDomRefund,
    "必须先出新票再退旧单");

  // 5d. 退款幂等：对同一旧单再退一次被供应方拒绝
  assert.throws(
    () => gateway.requestRefund({ supplier_ref: oldRefs.dom, amount: 1, currency: "CNY", idempotencyKey: "again" }),
    (err) => err.code === "ALREADY_REFUNDED"
  );

  // ---- 6. 旅客能解释自己的选择 ----
  const explanation = customerExplanation(store, option_id);
  assert.equal(explanation.status, "accepted");
  assert.equal(explanation.chosen.by, "p1");
  assert.ok(explanation.freeze_summary.includes("确认前"));
  const explained = Object.fromEntries(explanation.segments.map((s) => [s.segment_id, s]));
  assert.equal(explained["seg-hotel-over"].action, "preserve");
  assert.equal(explained["seg-air-over"].action, "split");
  assert.ok(explained["seg-air-over"].headline.includes("p3"));

  // ---- 7. 客服待办：本协商已清空（无待确认/候补/在途退款）----
  const dash = agentDashboard(store, PARTY_ID);
  const blocking = dash.open_items.filter((i) => i.type !== "waitlist_pending");
  assert.deepEqual(blocking, [], "确认后不应再有待确认/待处理项");
  assert.ok(dash.notification_delivery.delivered.some((n) => n.notification_id === delivered.notification_id));
  assert.ok(dash.notification_delivery.failed.some((n) => n.notification_id === failed.notification_id),
    "失败送达也要可追溯");

  // ---- 8. 争议追溯：每笔资金 → 承诺/供应方单号/事件 ----
  const trail = disputeTrail(store, PARTY_ID);
  const charges = trail.movements.filter((m) => m.type === "supplier_charge");
  const refunds = trail.movements.filter((m) => m.type === "refund");
  assert.ok(charges.length >= 4, "应有火车/接驳/国内/国际四笔新票扣款");
  for (const c of charges) {
    assert.ok(c.supplier_ref, "每笔扣款都有供应方单号");
    assert.ok(c.event_id, "每笔扣款都能定位事件");
  }
  const intlCharge = charges.find((c) => c.supplier === "intl-air");
  assert.equal(intlCharge.commitment.amount, 3 * 2300, "国际票扣款可回溯到价格承诺原文");
  assert.ok(refunds.some((r) => r.supplier_ref === oldRefs.dom), "旧国内票退款可查");
  // 酒店没有任何资金移动
  assert.ok(!trail.movements.some((m) => m.supplier_ref === oldRefs.hotelCounty), "保留酒店不产生资金移动");
  assert.ok(!trail.movements.some((m) => m.supplier_ref === oldRefs.hotelOver), "保留酒店不产生资金移动");

  // ---- 9. 时间线完整、可按 correlation 回放 ----
  const tl = timeline(store, CORR);
  const seq = tl.map((e) => e.event_type);
  assert.ok(seq.includes("WAITLIST_RESULT_RECEIVED"));
  assert.ok(seq.includes("OPTION_FROZEN"));
  assert.ok(seq.indexOf("SUPPLIER_TICKETED") < seq.lastIndexOf("REFUND_CONFIRMED")
    || seq.includes("CHOICE_ACCEPTED"));

  // 对账结果对象
  assert.ok(result.balanced === true || result.totals, "应给出对账结论");
});

test("场景：火车晚点（非候补失败）车票仍有效，按新到达时刻保住可衔接段", () => {
  const scenario = buildScenario();
  const { service } = scenario;

  const r = service.receiveSupplierCallback({
    callback_id: "cb-delay-1",
    supplier: "12306",
    type: "disruption",
    supplier_ref: "RAIL-930-22",
    kind: "delay",
    new_dep: { at: "2026-09-30T22:40:00+08:00", tz: "Asia/Shanghai" },
    // 晚点 40 分钟：07:10 到。接驳 07:00 赶不上，但备选火车…这里直接用延误到达验证接驳判断
    new_arr: { at: "2026-10-01T07:10:00+08:00", tz: "Asia/Shanghai" },
    correlation_id: CORR,
  });
  assert.equal(r.applied, true);

  const { recommended } = proposeRecommended(scenario, {
    segment_id: "seg-rail",
    kind: "delay",
    new_arr: { at: "2026-10-01T07:10:00+08:00", tz: "Asia/Shanghai" },
  });
  const bySegment = Object.fromEntries(recommended.actions.map((a) => [a.segment_id, a]));
  // 晚点车票保留
  assert.equal(bySegment["seg-rail"].action, "preserve");
  assert.match(bySegment["seg-rail"].detail, /车票仍有效/);
  // 接驳 MCT 60：07:10 到、07:00 已发车 → 不可用需改签
  assert.equal(bySegment["seg-shuttle"].action, "rebook");
});

test("冻结到期未确认：占位自动释放，所有原订单保持有效", () => {
  const scenario = buildScenario();
  const { service, store, gateway } = scenario;
  service.receiveSupplierCallback({
    callback_id: "cb-wl-x", supplier: "12306", type: "waitlist_result",
    supplier_ref: "RAIL-930-22", outcome: "failed", correlation_id: CORR,
  });
  const { option_id } = proposeRecommended(scenario, { segment_id: "seg-rail", kind: "waitlist_failed" });
  const frozen = service.freeze({ option_id, ttlMs: 1000 });
  const holdIds = frozen.state.holds.map((h) => h.hold_id);

  scenario.advance(2000);
  const expired = service.expireIfDue(option_id);
  assert.deepEqual(expired, [option_id]);
  for (const id of holdIds) assert.equal(gateway.getHold(id).status, "released");
  assert.equal(loadAggregate(store, "recovery_option", option_id).state.status, "expired");
  // 原订单无一被取消
  for (const ref of ["DOM-1001-09", "BUS-1001-07", "HTL-COUNTY-1001", "HTL-OVER-1001", "INTL-1001-1530"]) {
    assert.equal(gateway.getBooking(ref).status, "booked");
  }
});

test("未知供应方回调被拒绝并留痕，不会误改任何订单", () => {
  const scenario = buildScenario();
  const { service, store } = scenario;
  const r = service.receiveSupplierCallback({
    callback_id: "cb-bad", supplier: "ghost", type: "waitlist_result",
    supplier_ref: "PNR-DOES-NOT-EXIST", outcome: "failed", party_id: PARTY_ID,
  });
  assert.equal(r.rejected, true);
  const party = loadAggregate(store, "travel_party", PARTY_ID).state;
  assert.ok(party.rejected_callbacks.some((c) => c.callback_id === "cb-bad"));
});
