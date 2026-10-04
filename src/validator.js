import { EVENT_TYPES, AGGREGATE_TYPES } from "./contracts.js";

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

/**
 * 事件信封基础校验。保持对历史样例的兼容：
 * 只有七个必填字段的事件仍应返回 []。
 */
export function validateEvent(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return ["事件必须是对象"];
  }
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);

  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) {
    errors.push(`未知 event_type：${record.event_type}`);
  }
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) {
    errors.push(`未知 aggregate_type：${record.aggregate_type}`);
  }
  if ("event_id" in record && (typeof record.event_id !== "string" || record.event_id.length === 0)) {
    errors.push("event_id 必须是非空字符串");
  }
  if ("aggregate_id" in record && (typeof record.aggregate_id !== "string" || record.aggregate_id.length === 0)) {
    errors.push("aggregate_id 必须是非空字符串");
  }
  if ("summary" in record && (typeof record.summary !== "string" || record.summary.length === 0)) {
    errors.push("summary 必须是非空字符串");
  }
  if ("occurred_at" in record && Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 必须是可解析的 date-time");
  }
  return errors;
}
