import assert from "node:assert/strict";
import test from "node:test";

import { createServer } from "../src/http/server.js";
import { RecoveryService } from "../src/application/service.js";
import { SupplierGateway } from "../src/suppliers/gateway.js";
import { buildScenario, defaultAlternatives, CORR, PARTY_ID } from "./fixtures/scenario.js";

async function withServer(fn) {
  const scenario = buildScenario();
  const server = createServer(scenario.service);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn({ base, ...scenario });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const req = async (base, method, path, body, idemKey = null) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(idemKey ? { "idempotency-key": idemKey } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
};

test("HTTP 全流程：回调→提案→冻结→送达→确认→读侧视图", () =>
  withServer(async ({ base, refundPolicies }) => {
    // 回调
    let r = await req(base, "POST", "/callbacks", {
      callback_id: "http-cb-1", supplier: "12306", type: "waitlist_result",
      supplier_ref: "RAIL-930-22", outcome: "failed", correlation_id: CORR,
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.applied, true);
    // 重复回调
    r = await req(base, "POST", "/callbacks", {
      callback_id: "http-cb-1", supplier: "12306", type: "waitlist_result",
      supplier_ref: "RAIL-930-22", outcome: "failed", correlation_id: CORR,
    });
    assert.equal(r.json.duplicate, true);

    // 提案
    const prop = await req(base, "POST", `/parties/${PARTY_ID}/propose`, {
      correlation_id: CORR,
      disruption: { segment_id: "seg-rail", kind: "waitlist_failed" },
      alternatives: defaultAlternatives(),
      refundPolicies,
    });
    assert.equal(prop.status, 201);
    const optionId = prop.json.option_id;

    // 冻结（同一幂等键连打两次：不得产生两套占位）
    const f1 = await req(base, "POST", `/options/${optionId}/freeze`, {}, "freeze-key-1");
    const f2 = await req(base, "POST", `/options/${optionId}/freeze`, {}, "freeze-key-1");
    assert.equal(f1.status, 200);
    assert.equal(f2.json.replayed, true);
    assert.deepEqual(f2.json.holds, f1.json.holds);
    assert.ok(f1.json.summary.includes("确认前"));

    // 不带幂等键再冻一次：状态机拒绝
    const f3 = await req(base, "POST", `/options/${optionId}/freeze`, {});
    assert.equal(f3.status, 400);

    // 通知
    const n = await req(base, "POST", `/options/${optionId}/notify`, { channel: "sms" });
    assert.equal(n.status, 200);
    assert.equal(n.json.state, "delivered");

    // 确认
    const acc = await req(base, "POST", `/options/${optionId}/accept`, {
      by: "p1", notification_id: n.json.notification_id,
    });
    assert.equal(acc.status, 200, JSON.stringify(acc.json));

    // 旅客解释
    const expl = await req(base, "GET", `/options/${optionId}/explanation`);
    assert.equal(expl.json.status, "accepted");
    assert.equal(expl.json.chosen.by, "p1");

    // 客服待办
    const dash = await req(base, "GET", `/parties/${PARTY_ID}/dashboard`);
    assert.equal(dash.json.is_clear, true);

    // 争议资金链
    const trail = await req(base, "GET", `/parties/${PARTY_ID}/trail`);
    assert.ok(trail.json.movements.length > 0);
    assert.ok(trail.json.movements.every((m) => m.event_id && (m.supplier_ref || m.payment_id)));

    // 时间线
    const tl = await req(base, "GET", `/correlations/${CORR}/timeline`);
    assert.ok(tl.json.events.some((e) => e.event_type === "CHOICE_ACCEPTED"));
  }));

test("HTTP：未送达通知不能确认（409）", () =>
  withServer(async ({ base, refundPolicies }) => {
    await req(base, "POST", "/callbacks", {
      callback_id: "http-cb-2", supplier: "12306", type: "waitlist_result",
      supplier_ref: "RAIL-930-22", outcome: "failed", correlation_id: CORR,
    });
    const prop = await req(base, "POST", `/parties/${PARTY_ID}/propose`, {
      correlation_id: CORR,
      disruption: { segment_id: "seg-rail", kind: "waitlist_failed" },
      alternatives: defaultAlternatives(),
      refundPolicies,
    });
    const optionId = prop.json.option_id;
    await req(base, "POST", `/options/${optionId}/freeze`, {}, "fk2");
    const bad = await req(base, "POST", `/options/${optionId}/notify`, { channel: "failing_channel", to: "13800000000" });
    assert.equal(bad.status, 502);
    const acc = await req(base, "POST", `/options/${optionId}/accept`, { by: "p1", notification_id: bad.json.notification_id });
    assert.equal(acc.status, 409);
    assert.match(acc.json.error, /未真正送达/);
  }));

test("服务可脱离 HTTP 直接装配（RecoveryService 默认依赖）", () => {
  const svc = new RecoveryService({ gateway: new SupplierGateway() });
  assert.ok(typeof svc.propose === "function");
});
