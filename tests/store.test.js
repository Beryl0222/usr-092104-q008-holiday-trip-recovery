import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/domain/store.js";

const baseEvent = (over = {}) => ({
  event_id: "e1",
  event_type: "SEGMENT_CONFIRMED",
  aggregate_type: "booking_segment",
  aggregate_id: "s1",
  occurred_at: "2026-10-01T08:00:00Z",
  version: 1,
  summary: "x",
  ...over,
});

const throwsCode = (fn, code) =>
  assert.throws(fn, (err) => err.code === code, `应抛出 ${code}`);

test("event_id 全局唯一：重复事件被拒绝（重复回调不会二次生效）", () => {
  const store = new EventStore();
  store.append(baseEvent(), 0);
  throwsCode(
    () => store.append(baseEvent({ aggregate_id: "other", version: 1 }), 0),
    "DUPLICATE_EVENT"
  );
});

test("流内版本必须连续，乐观锁冲突被拒绝", () => {
  const store = new EventStore();
  store.append(baseEvent(), 0);
  throwsCode(() => store.append(baseEvent({ event_id: "e2", version: 3 }), 1), "VERSION_GAP");
  throwsCode(() => store.append(baseEvent({ event_id: "e3", version: 2 }), 0), "VERSION_CONFLICT");
  store.append(baseEvent({ event_id: "e4", version: 2 }), 1);
  assert.equal(store.streamVersion("booking_segment", "s1"), 2);
});

test("不同聚合流各自从 1 开始", () => {
  const store = new EventStore();
  store.append(baseEvent(), 0);
  store.append(baseEvent({ event_id: "e2", aggregate_id: "s2" }), 0);
  assert.equal(store.load("booking_segment", "s2")[0].version, 1);
});
