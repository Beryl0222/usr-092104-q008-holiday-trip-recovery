import assert from "node:assert/strict";
import test from "node:test";

import {
  belongsToPreviousServiceNight,
  gapMinutes,
  localDate,
  localDateTime,
  meetsMinimumConnection,
} from "../src/domain/time.js";

test("跨午夜红眼到达仍计入前一营业日那晚住房", () => {
  // 入住 10-01，航班次日凌晨 01:30 落地，04:00 夜切前 → 保住 10-01 那晚，不新增一晚
  const arrival = new Date("2026-10-02T01:30:00+08:00");
  assert.equal(belongsToPreviousServiceNight(arrival, "Asia/Shanghai", "2026-10-01"), true);
  // 05:00 落地超过夜切 → 不再属于前一晚
  assert.equal(belongsToPreviousServiceNight(new Date("2026-10-02T05:00:00+08:00"), "Asia/Shanghai", "2026-10-01"), false);
});

test("酒店按当地日期判定，入住日当天到达保留", () => {
  assert.equal(localDate(new Date("2026-10-01T23:50:00+09:00"), "Asia/Tokyo"), "2026-10-01");
});

test("跨时区衔接按绝对分钟计算，夏令时也不倒退", () => {
  // 北京 15:30(+08) 起飞，东京 18:30(+09) 到达：绝对飞行 120 分钟
  const dep = new Date("2026-10-01T15:30:00+08:00");
  const arr = new Date("2026-10-01T18:30:00+09:00");
  assert.equal(gapMinutes(dep, arr), 120);
  // MCT 150 分钟：08:05 到达、09:00 出发的衔接只有 55 分钟，不满足
  assert.equal(
    meetsMinimumConnection(new Date("2026-10-01T08:05:00+08:00"), new Date("2026-10-01T09:00:00+08:00"), 120),
    false
  );
  assert.equal(
    meetsMinimumConnection(new Date("2026-10-01T07:00:00+08:00"), new Date("2026-10-01T09:00:00+08:00"), 120),
    true
  );
});

test("local 字符串是 at+tz 的投影，UTC 与东京分量不同", () => {
  const instant = new Date("2026-10-01T15:30:00+08:00");
  assert.equal(localDateTime(instant, "Asia/Shanghai"), "2026-10-01T15:30");
  assert.equal(localDateTime(instant, "Asia/Tokyo"), "2026-10-01T16:30");
});
