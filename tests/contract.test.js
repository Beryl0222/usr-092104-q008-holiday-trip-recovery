import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent, validateSequence } from "../src/validator.js";

const loadJson = async (name) => JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), "utf8"));

function baseEvent(overrides = {}) {
  return {
    event_id: "evt-t1",
    event_type: "SEGMENT_CONFIRMED",
    aggregate_type: "booking_segment",
    aggregate_id: "seg-t1",
    occurred_at: "2026-09-30T20:00:00+08:00",
    version: 1,
    summary: "测试事件",
    payload: {
      party_id: "party-t1",
      segment_kind: "train",
      supplier: "铁路12306",
      supplier_order_id: "E1",
      supplier_status: "ticketed",
      timezone: "Asia/Shanghai",
    },
    ...overrides,
  };
}

test("样例符合领域约定", async () => {
  const sample = await loadJson("sample.json");
  assert.deepEqual(validateEvent(sample), []);
});

test("样例事件流逐条合法且顺序不变量成立", async () => {
  const flow = await loadJson("sample-flow.json");
  for (const event of flow) {
    assert.deepEqual(validateEvent(event), [], `${event.event_id} 应通过单事件校验`);
  }
  assert.deepEqual(validateSequence(flow), []);
});

test("拒绝未知事件类型与未知聚合类型", () => {
  assert.ok(validateEvent(baseEvent({ event_type: "FOO" })).some((e) => e.includes("未知事件类型")));
  assert.ok(validateEvent(baseEvent({ aggregate_type: "bar" })).some((e) => e.includes("未知聚合类型")));
});

test("事件必须挂在正确的聚合上", () => {
  const errors = validateEvent(baseEvent({ aggregate_type: "travel_party" }));
  assert.ok(errors.some((e) => e.includes("必须挂在聚合 booking_segment 上")));
});

test("occurred_at 必须带时区偏移", () => {
  const errors = validateEvent(baseEvent({ occurred_at: "2026-09-30T20:00:00" }));
  assert.ok(errors.some((e) => e.includes("时区偏移")));
});

test("按事件类型校验 payload 必填字段", () => {
  const event = baseEvent();
  delete event.payload.timezone;
  assert.ok(validateEvent(event).some((e) => e.includes("payload 缺少字段：timezone")));
  assert.ok(validateEvent(baseEvent({ payload: undefined })).some((e) => e.includes("缺少对象字段：payload")));
});

function optionFlow() {
  return [
    {
      event_id: "e1",
      event_type: "OPTION_PROPOSED",
      aggregate_type: "recovery_option",
      aggregate_id: "opt-t",
      occurred_at: "2026-09-30T21:00:00+08:00",
      version: 1,
      summary: "出价",
      payload: {
        party_id: "p",
        disruption_event_id: "e0",
        option_kind: "rebook",
        added_cost: { amount: 100, currency: "CNY" },
        forfeited_benefits: [],
        pending_suppliers: ["航司A"],
      },
    },
    {
      event_id: "e2",
      event_type: "OPTION_FREEZED",
      aggregate_type: "recovery_option",
      aggregate_id: "opt-t",
      occurred_at: "2026-09-30T21:05:00+08:00",
      version: 2,
      summary: "冻结",
      payload: { freeze_id: "frz-t", expires_at: "2026-09-30T22:00:00+08:00" },
    },
    {
      event_id: "e3",
      event_type: "CHOICE_ACCEPTED",
      aggregate_type: "recovery_option",
      aggregate_id: "opt-t",
      occurred_at: "2026-09-30T21:30:00+08:00",
      version: 3,
      summary: "确认",
      payload: { freeze_id: "frz-t", accepted_by: "m-01" },
    },
  ];
}

test("未冻结不得确认，冻结过期不得确认", () => {
  const [proposed, freezed, accepted] = optionFlow();
  assert.ok(validateSequence([proposed, accepted]).some((e) => e.includes("未先冻结")));
  const late = { ...accepted, occurred_at: "2026-09-30T23:00:00+08:00" };
  assert.ok(validateSequence([proposed, freezed, late]).some((e) => e.includes("晚于冻结到期时间")));
  assert.deepEqual(validateSequence([proposed, freezed, accepted]), []);
});

test("未经确认不得保留、改签或取消仍有效订单", () => {
  const rebooked = {
    event_id: "e9",
    event_type: "SEGMENT_REBOOKED",
    aggregate_type: "booking_segment",
    aggregate_id: "seg-t9",
    occurred_at: "2026-09-30T22:00:00+08:00",
    version: 1,
    summary: "改签",
    payload: { based_on_choice: "不存在的确认", supplier_order_id: "A-1" },
  };
  assert.ok(validateSequence([rebooked]).some((e) => e.includes("未经旅客确认")));
  const [, , accepted] = optionFlow();
  const ok = { ...rebooked, payload: { ...rebooked.payload, based_on_choice: "e3" } };
  assert.deepEqual(validateSequence([...optionFlow(), ok]), []);
});

test("供应方回调幂等：重复应用报错，重复留痕需有首次记录", () => {
  const applied = {
    event_id: "c1",
    event_type: "SUPPLIER_CALLBACK_APPLIED",
    aggregate_type: "supplier_callback",
    aggregate_id: "scb-t",
    occurred_at: "2026-09-30T22:00:00+08:00",
    version: 1,
    summary: "回调",
    payload: { supplier: "航司A", callback_id: "cb-1", segment_id: "seg-t9", reported_status: "ticketed" },
  };
  const reapplied = { ...applied, event_id: "c2", aggregate_id: "scb-t2", version: 1, occurred_at: "2026-09-30T22:01:00+08:00" };
  assert.ok(validateSequence([applied, reapplied]).some((e) => e.includes("重复应用")));
  const duplicate = { ...applied, event_id: "c3", event_type: "SUPPLIER_CALLBACK_DUPLICATE", version: 2, occurred_at: "2026-09-30T22:02:00+08:00" };
  assert.deepEqual(validateSequence([applied, duplicate]), []);
  assert.ok(validateSequence([duplicate]).some((e) => e.includes("没有对应的首次应用记录")));
});

test("资金核销必须引用已登记的价格承诺", () => {
  const reconciled = {
    event_id: "f1",
    event_type: "FUNDS_RECONCILED",
    aggregate_type: "financial_resolution",
    aggregate_id: "fin-t",
    occurred_at: "2026-10-01T09:00:00+08:00",
    version: 1,
    summary: "核销",
    payload: { party_id: "p", lines: [{ kind: "charge", amount: 180, currency: "CNY", promise_id: "prm-x" }] },
  };
  assert.ok(validateSequence([reconciled]).some((e) => e.includes("未登记的价格承诺")));
  const promised = {
    event_id: "f0",
    event_type: "PRICE_PROMISED",
    aggregate_type: "recovery_option",
    aggregate_id: "opt-t",
    occurred_at: "2026-09-30T21:06:00+08:00",
    version: 1,
    summary: "承诺",
    payload: { promise_id: "prm-x", amount: 200, currency: "CNY" },
  };
  assert.deepEqual(validateSequence([promised, reconciled]), []);
});

test("同一聚合版本号必须逐条递增", () => {
  const [proposed, freezed] = optionFlow();
  const jumped = { ...freezed, version: 5 };
  assert.ok(validateSequence([proposed, jumped]).some((e) => e.includes("版本号应为 2")));
});
