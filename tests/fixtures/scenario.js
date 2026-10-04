/**
 * 双节联程测试夹具：一家四口 9.30 晚出发的联程。
 *
 * 火车（第一段，候补）→ 国内航班 → 县城接驳 → 县城酒店
 *                                          → 境外航班（后半程，次日）→ 境外酒店
 *
 * 成员证件：
 * - p1/p2 成人：护照充裕
 * - p3 孩子：护照有效期不足（受限成员，需要拆分同行）
 * - p4 老人：无境外段要求标记（默认不随境外受限名单）
 */

import { EventStore } from "../../src/domain/store.js";
import { RecoveryService } from "../../src/application/service.js";
import { SupplierGateway } from "../../src/suppliers/gateway.js";

export const MEMBERS = [
  { member_id: "p1", name: "成人甲", documents: [{ type: "passport", valid_until: "2030-06-01" }] },
  { member_id: "p2", name: "成人乙", documents: [{ type: "passport", valid_until: "2029-03-01" }] },
  { member_id: "p3", name: "孩子", documents: [{ type: "passport", valid_until: "2026-11-01" }] },
  { member_id: "p4", name: "老人", documents: [{ type: "passport", valid_until: "2031-01-01" }] },
];

export const PARTY_ID = "party-chen";
export const CORR = "disr-2026-1001";

/**
 * @param {{now?:Date, gateway?:SupplierGateway, channels?:object}} [opts]
 */
export function buildScenario(opts = {}) {
  const now = opts.now ?? new Date("2026-09-30T20:00:00+08:00");
  let t = 0;
  const idFactory = (prefix) => `${prefix}-${String(++t).padStart(4, "0")}`;
  const gateway = opts.gateway ?? new SupplierGateway({ now: () => now });
  const store = new EventStore();
  const service = new RecoveryService({
    store,
    gateway,
    now: () => now,
    idFactory,
    channels: opts.channels ?? {
      sms: async () => ({ provider_id: `sms-${Date.now()}` }),
      app_push: async () => ({ provider_id: `push-${Date.now()}` }),
      failing_channel: async () => {
        throw new Error("运营商网关超时");
      },
    },
    holdTtlMs: 30 * 60_000,
  });

  service.registerParty({
    party_id: PARTY_ID,
    members: MEMBERS,
    preferences: { seating: "全家相邻", notify: ["sms"], split_policy: "证件受限成员可与监护人拆分" },
    contacts: [
      { channel: "sms", address: "13800000000" },
      { channel: "app_push", address: "device-chen-1" },
    ],
    correlation_id: CORR,
  });

  const z = (at, tz) => ({ at, tz, local: at.slice(0, 16) });
  const CNY = (amount) => ({ amount, currency: "CNY" });

  // 1) 火车：9.30 22:00 → 县城 10.1 06:30（候补状态，可能失败）
  service.registerSegment({
    segment_id: "seg-rail",
    party_id: PARTY_ID,
    kind: "railway",
    supplier: "12306",
    supplier_ref: "RAIL-930-22",
    price: CNY(4 * 280),
    origin: "home",
    destination: "county-city",
    dep: z("2026-09-30T22:00:00+08:00", "Asia/Shanghai"),
    arr: z("2026-10-01T06:30:00+08:00", "Asia/Shanghai"),
    tz: "Asia/Shanghai",
    passenger_ids: ["p1", "p2", "p3", "p4"],
    depends_on: [],
    status: "waitlisted",
    correlation_id: CORR,
  });

  // 2) 国内航班：10.1 09:00 → 口岸城市 11:00
  service.registerSegment({
    segment_id: "seg-air-dom",
    party_id: PARTY_ID,
    kind: "domestic_air",
    supplier: "china-local-air",
    supplier_ref: "DOM-1001-09",
    price: CNY(4 * 860),
    origin: "county-city",
    destination: "port-city",
    dep: z("2026-10-01T09:00:00+08:00", "Asia/Shanghai"),
    arr: z("2026-10-01T11:00:00+08:00", "Asia/Shanghai"),
    tz: "Asia/Shanghai",
    passenger_ids: ["p1", "p2", "p3", "p4"],
    depends_on: ["seg-rail"],
    correlation_id: CORR,
  });

  // 3) 境外航班：10.1 15:30 口岸 → 10.1 18:30 当地（+09:00）
  service.registerSegment({
    segment_id: "seg-air-over",
    party_id: PARTY_ID,
    kind: "overseas_air",
    supplier: "intl-air",
    supplier_ref: "INTL-1001-1530",
    price: CNY(4 * 2100),
    origin: "port-city",
    destination: "overseas-city",
    dep: z("2026-10-01T15:30:00+08:00", "Asia/Shanghai"),
    arr: z("2026-10-01T18:30:00+09:00", "Asia/Tokyo"),
    tz: "Asia/Shanghai",
    passenger_ids: ["p1", "p2", "p3", "p4"],
    depends_on: ["seg-air-dom"],
    document_requirement: {
      documentType: "passport",
      requiredUntil: "2026-10-08",
      minRemainingDays: 180,
      restricted_member_ids: ["p1", "p2", "p3", "p4"],
    },
    correlation_id: CORR,
  });

  // 4) 县城接驳：10.1 07:00（酒店方向）
  service.registerSegment({
    segment_id: "seg-shuttle",
    party_id: PARTY_ID,
    kind: "county_shuttle",
    supplier: "county-bus",
    supplier_ref: "BUS-1001-07",
    price: CNY(4 * 35),
    origin: "county-city-station",
    destination: "county-hotel",
    dep: z("2026-10-01T07:00:00+08:00", "Asia/Shanghai"),
    arr: z("2026-10-01T07:40:00+08:00", "Asia/Shanghai"),
    tz: "Asia/Shanghai",
    passenger_ids: ["p1", "p2", "p3", "p4"],
    depends_on: ["seg-rail"],
    correlation_id: CORR,
  });

  // 5) 县城酒店：入住 10.1 一晚（跨午夜红眼也保住当晚）
  service.registerSegment({
    segment_id: "seg-hotel-county",
    party_id: PARTY_ID,
    kind: "hotel",
    supplier: "county-inn",
    supplier_ref: "HTL-COUNTY-1001",
    price: CNY(680),
    origin: "county-hotel",
    destination: "county-hotel",
    dep: z("2026-10-01T14:00:00+08:00", "Asia/Shanghai"),
    arr: z("2026-10-02T12:00:00+08:00", "Asia/Shanghai"),
    tz: "Asia/Shanghai",
    service_date: "2026-10-01",
    night_cutoff_minutes: 4 * 60,
    passenger_ids: ["p1", "p2", "p3", "p4"],
    depends_on: ["seg-shuttle"],
    correlation_id: CORR,
  });

  // 6) 境外酒店：10.1 当晚（跨时区，当地入住）
  service.registerSegment({
    segment_id: "seg-hotel-over",
    party_id: PARTY_ID,
    kind: "overseas_hotel",
    supplier: "overseas-inn",
    supplier_ref: "HTL-OVER-1001",
    price: CNY(1280),
    origin: "overseas-city",
    destination: "overseas-city",
    dep: z("2026-10-01T20:00:00+09:00", "Asia/Tokyo"),
    arr: z("2026-10-02T11:00:00+09:00", "Asia/Tokyo"),
    tz: "Asia/Tokyo",
    service_date: "2026-10-01",
    night_cutoff_minutes: 4 * 60,
    passenger_ids: ["p1", "p2", "p3", "p4"],
    depends_on: ["seg-air-over"],
    correlation_id: CORR,
  });

  const refundPolicies = {
    "seg-air-dom": { refundable: CNY(4 * 860 * 0.6), penalty: "起飞前 40%", note: "起飞前可退 60%" },
    "seg-air-over": { refundable: CNY(4 * 2100 * 0.5), penalty: "50%", note: "特价国际票退 50%" },
    "seg-shuttle": { refundable: CNY(4 * 35 * 0.8), penalty: "20%", note: "接驳可退 80%" },
    "seg-hotel-county": { refundable: CNY(680), penalty: "0", note: "当天 18 点前免费取消" },
    "seg-hotel-over": { refundable: CNY(1280 * 0.7), penalty: "30%", note: "境外酒店退 70%" },
    "seg-rail": { refundable: CNY(0), penalty: "候补失败无扣费", note: "候补不成团自动释放" },
  };

  return { service, store, gateway, now, refundPolicies, PARTY_ID, CORR, advance: (ms) => { now.setTime(now.getTime() + ms); } };
}

/** 常用备选：改签下一班国内航班、接驳、境外航班（合格成员 3 人） */
export function defaultAlternatives() {
  const z = (at, tz) => ({ at, tz, local: at.slice(0, 16) });
  const CNY = (amount) => ({ amount, currency: "CNY" });
  return [
    {
      replaces_segment_id: "seg-rail",
      alternative_id: "rail-late",
      supplier: "12306",
      kind: "railway",
      dep: z("2026-09-30T23:30:00+08:00", "Asia/Shanghai"),
      arr: z("2026-10-01T08:05:00+08:00", "Asia/Shanghai"),
      price: CNY(4 * 300),
      seats: 4,
    },
    {
      replaces_segment_id: "seg-shuttle",
      alternative_id: "bus-late",
      supplier: "county-bus",
      kind: "county_shuttle",
      dep: z("2026-10-01T09:30:00+08:00", "Asia/Shanghai"),
      arr: z("2026-10-01T10:10:00+08:00", "Asia/Shanghai"),
      price: CNY(4 * 35),
      seats: 4,
    },
    {
      replaces_segment_id: "seg-air-dom",
      alternative_id: "dom-noon",
      supplier: "china-local-air",
      kind: "domestic_air",
      dep: z("2026-10-01T12:30:00+08:00", "Asia/Shanghai"),
      arr: z("2026-10-01T14:30:00+08:00", "Asia/Shanghai"),
      price: CNY(4 * 980),
      seats: 4,
    },
    {
      replaces_segment_id: "seg-air-over",
      alternative_id: "intl-evening",
      supplier: "intl-air",
      kind: "overseas_air",
      dep: z("2026-10-01T21:00:00+08:00", "Asia/Shanghai"),
      arr: z("2026-10-02T00:35:00+09:00", "Asia/Tokyo"),
      price: CNY(3 * 2300),
      seats: 3,
      covers: ["p1", "p2", "p4"],
    },
  ];
}
