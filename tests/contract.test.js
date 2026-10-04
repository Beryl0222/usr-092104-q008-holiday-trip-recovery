import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { EVENT_TYPES, AGGREGATE_TYPES } from "../src/contracts.js";

test("样例符合领域约定（历史七字段信封仍然合法）", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("代码事件目录与 schema 枚举一致（只追加、两处同步）", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(schema.properties.event_type.enum, EVENT_TYPES);
  assert.deepEqual(schema.properties.aggregate_type.enum, AGGREGATE_TYPES);
  // 前五个为既有事件，顺序永远不动
  assert.deepEqual(
    EVENT_TYPES.slice(0, 5),
    ["SEGMENT_CONFIRMED", "DISRUPTION_RECEIVED", "OPTION_PROPOSED", "CHOICE_ACCEPTED", "FUNDS_RECONCILED"]
  );
});

test("校验器拒绝缺字段、坏版本、未知类型", () => {
  assert.ok(validateEvent({}).length >= 5);
  assert.ok(validateEvent({
    event_id: "x", event_type: "NOPE", aggregate_type: "booking_segment",
    aggregate_id: "y", occurred_at: "bad", version: 0, summary: "",
  }).length >= 4);
  assert.deepEqual(validateEvent({
    event_id: "x", event_type: "SEGMENT_BOOKED", aggregate_type: "booking_segment",
    aggregate_id: "y", occurred_at: "2026-10-01T00:00:00Z", version: 1, summary: "ok",
  }), []);
});
