const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

export const EVENT_TYPES = [
  "SEGMENT_CONFIRMED",
  "DISRUPTION_RECEIVED",
  "OPTION_PROPOSED",
  "OPTION_FREEZED",
  "PRICE_PROMISED",
  "CHOICE_ACCEPTED",
  "SEGMENT_HELD",
  "SEGMENT_REBOOKED",
  "SEGMENT_CANCELLED",
  "PARTY_SPLIT",
  "DOCUMENT_RESTRICTION_FLAGGED",
  "SUPPLIER_CALLBACK_APPLIED",
  "SUPPLIER_CALLBACK_DUPLICATE",
  "NOTIFICATION_DISPATCHED",
  "NOTIFICATION_DELIVERED",
  "NOTIFICATION_FAILED",
  "FUNDS_RECONCILED",
];

export const AGGREGATE_TYPES = [
  "travel_party",
  "booking_segment",
  "recovery_option",
  "financial_resolution",
  "supplier_callback",
  "notification_delivery",
];

const EVENT_AGGREGATE = {
  SEGMENT_CONFIRMED: "booking_segment",
  DISRUPTION_RECEIVED: "booking_segment",
  OPTION_PROPOSED: "recovery_option",
  OPTION_FREEZED: "recovery_option",
  PRICE_PROMISED: "recovery_option",
  CHOICE_ACCEPTED: "recovery_option",
  SEGMENT_HELD: "booking_segment",
  SEGMENT_REBOOKED: "booking_segment",
  SEGMENT_CANCELLED: "booking_segment",
  PARTY_SPLIT: "travel_party",
  DOCUMENT_RESTRICTION_FLAGGED: "travel_party",
  SUPPLIER_CALLBACK_APPLIED: "supplier_callback",
  SUPPLIER_CALLBACK_DUPLICATE: "supplier_callback",
  NOTIFICATION_DISPATCHED: "notification_delivery",
  NOTIFICATION_DELIVERED: "notification_delivery",
  NOTIFICATION_FAILED: "notification_delivery",
  FUNDS_RECONCILED: "financial_resolution",
};

const PAYLOAD_REQUIRED = {
  SEGMENT_CONFIRMED: ["party_id", "segment_kind", "supplier", "supplier_order_id", "supplier_status", "timezone"],
  DISRUPTION_RECEIVED: ["cause", "detected_at"],
  OPTION_PROPOSED: ["party_id", "disruption_event_id", "option_kind", "added_cost", "forfeited_benefits", "pending_suppliers"],
  OPTION_FREEZED: ["freeze_id", "expires_at"],
  PRICE_PROMISED: ["promise_id", "amount", "currency"],
  CHOICE_ACCEPTED: ["freeze_id", "accepted_by"],
  SEGMENT_HELD: ["based_on_choice", "supplier_order_id"],
  SEGMENT_REBOOKED: ["based_on_choice", "supplier_order_id"],
  SEGMENT_CANCELLED: ["based_on_choice", "supplier_order_id"],
  PARTY_SPLIT: ["new_party_id", "moved_member_ids", "reason"],
  DOCUMENT_RESTRICTION_FLAGGED: ["member_id", "valid_until"],
  SUPPLIER_CALLBACK_APPLIED: ["supplier", "callback_id", "segment_id", "reported_status"],
  SUPPLIER_CALLBACK_DUPLICATE: ["supplier", "callback_id", "segment_id", "reported_status"],
  NOTIFICATION_DISPATCHED: ["party_id", "channel", "related_event_id"],
  NOTIFICATION_DELIVERED: ["party_id", "channel", "related_event_id"],
  NOTIFICATION_FAILED: ["party_id", "channel", "related_event_id"],
  FUNDS_RECONCILED: ["party_id", "lines"],
};

const DATETIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) errors.push(`未知事件类型：${record.event_type}`);
  if ("aggregate_type" in record) {
    if (!AGGREGATE_TYPES.includes(record.aggregate_type)) {
      errors.push(`未知聚合类型：${record.aggregate_type}`);
    } else if (EVENT_TYPES.includes(record.event_type) && EVENT_AGGREGATE[record.event_type] !== record.aggregate_type) {
      errors.push(`事件 ${record.event_type} 必须挂在聚合 ${EVENT_AGGREGATE[record.event_type]} 上`);
    }
  }
  if (
    "occurred_at" in record &&
    (typeof record.occurred_at !== "string" || !DATETIME_WITH_OFFSET.test(record.occurred_at) || Number.isNaN(Date.parse(record.occurred_at)))
  ) {
    errors.push("occurred_at 必须是带时区偏移的日期时间");
  }
  const needed = PAYLOAD_REQUIRED[record.event_type];
  if (needed) {
    if (typeof record.payload !== "object" || record.payload === null || Array.isArray(record.payload)) {
      errors.push("缺少对象字段：payload");
    } else {
      for (const field of needed) {
        if (!(field in record.payload)) errors.push(`payload 缺少字段：${field}`);
      }
    }
  }
  return errors;
}

// 事件序列不变量：同一聚合版本逐条递增；方案先冻结后确认且不得在冻结过期后确认；
// 保留/改签/取消必须引用已确认的选择；供应方回调按 supplier+callback_id 幂等；
// 资金核销引用的价格承诺必须事先登记。
export function validateSequence(events) {
  const errors = [];
  const versions = new Map();
  const freezes = new Map();
  const acceptedChoices = new Set();
  const appliedCallbacks = new Set();
  const promises = new Set();

  events.forEach((event, index) => {
    const at = `第${index + 1}条(${event.event_id ?? "无event_id"})`;
    const key = `${event.aggregate_type}/${event.aggregate_id}`;
    if (versions.has(key)) {
      const expected = versions.get(key) + 1;
      if (event.version !== expected) errors.push(`${at} 版本号应为 ${expected}，实际为 ${event.version}`);
    }
    versions.set(key, event.version);

    const payload = event.payload ?? {};
    switch (event.event_type) {
      case "OPTION_FREEZED": {
        if (!freezes.has(event.aggregate_id)) freezes.set(event.aggregate_id, new Map());
        freezes.get(event.aggregate_id).set(payload.freeze_id, payload.expires_at);
        break;
      }
      case "PRICE_PROMISED":
        promises.add(payload.promise_id);
        break;
      case "CHOICE_ACCEPTED": {
        const frozen = freezes.get(event.aggregate_id);
        if (!frozen || !frozen.has(payload.freeze_id)) {
          errors.push(`${at} 确认的方案未先冻结（freeze_id=${payload.freeze_id}）`);
        } else if (Date.parse(event.occurred_at) > Date.parse(frozen.get(payload.freeze_id))) {
          errors.push(`${at} 确认时间晚于冻结到期时间 ${frozen.get(payload.freeze_id)}`);
        }
        acceptedChoices.add(event.event_id);
        break;
      }
      case "SEGMENT_HELD":
      case "SEGMENT_REBOOKED":
      case "SEGMENT_CANCELLED":
        if (!acceptedChoices.has(payload.based_on_choice)) {
          errors.push(`${at} 未经旅客确认不得变更仍有效订单（based_on_choice=${payload.based_on_choice}）`);
        }
        break;
      case "SUPPLIER_CALLBACK_APPLIED": {
        const callbackKey = `${payload.supplier}::${payload.callback_id}`;
        if (appliedCallbacks.has(callbackKey)) {
          errors.push(`${at} 供应方回调重复应用（${callbackKey}），会造成二次占位或退款`);
        }
        appliedCallbacks.add(callbackKey);
        break;
      }
      case "SUPPLIER_CALLBACK_DUPLICATE":
        if (!appliedCallbacks.has(`${payload.supplier}::${payload.callback_id}`)) {
          errors.push(`${at} 被标记为重复的回调没有对应的首次应用记录`);
        }
        break;
      case "FUNDS_RECONCILED":
        for (const line of payload.lines ?? []) {
          if (line.promise_id && !promises.has(line.promise_id)) {
            errors.push(`${at} 资金明细引用了未登记的价格承诺（promise_id=${line.promise_id}）`);
          }
        }
        break;
      default:
        break;
    }
  });
  return errors;
}
