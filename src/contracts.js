/**
 * 领域事件目录。只追加、不复用、不改语义——这是各供应方与保障团队之间的交换格式契约。
 * 前五个为仓库既有事件，顺序不得调整。
 */
export const EVENT_TYPES = [
  // 既有事件（v0.1）
  "SEGMENT_CONFIRMED",
  "DISRUPTION_RECEIVED",
  "OPTION_PROPOSED",
  "CHOICE_ACCEPTED",
  "FUNDS_RECONCILED",
  // v0.2 追加
  "PARTY_REGISTERED",
  "SEGMENT_BOOKED",
  "SEGMENT_PRESERVED",
  "SEGMENT_SPLIT",
  "SEGMENT_REBOOKED",
  "SEGMENT_CANCELLED",
  "WAITLIST_RESULT_RECEIVED",
  "PRICE_COMMITMENT_RECORDED",
  "OPTION_FROZEN",
  "OPTION_EXPIRED",
  "OPTION_REJECTED",
  "SUPPLIER_HOLD_PLACED",
  "SUPPLIER_HOLD_RELEASED",
  "SUPPLIER_TICKETED",
  "SUPPLIER_PRICE_CHANGED",
  "REFUND_REQUESTED",
  "REFUND_CONFIRMED",
  "CALLBACK_REJECTED",
  "NOTIFICATION_ATTEMPTED",
  "NOTIFICATION_DELIVERED",
  "NOTIFICATION_FAILED",
  "PAYMENT_COLLECTED",
];

export const AGGREGATE_TYPES = [
  "travel_party",
  "booking_segment",
  "recovery_option",
  "financial_resolution",
];

export const SEGMENT_KINDS = [
  "railway",            // 火车/高铁第一段
  "domestic_air",       // 国内航班
  "county_shuttle",     // 县城接驳
  "hotel",              // 国内酒店
  "overseas_air",       // 境外航段（后半程）
  "overseas_hotel",     // 境外酒店
];

// 供应方侧订单状态（每段保留供应方自己的状态机）
export const SUPPLIER_STATUSES = [
  "booked",          // 已出票/有效订单
  "waitlisted",      // 候补中
  "hold",            // 方案冻结产生的临时占位，尚未替换任何有效订单
  "ticketed",        // 占位已出票（新单）
  "cancelled",       // 已取消
  "refunded",        // 已退款
  "failed",          // 候补失败/出票失败
];

// 方案内对每一段的动作
export const ACTIONS = ["preserve", "rebook", "split", "cancel"];

export const OPTION_STATUSES = ["proposed", "frozen", "accepted", "rejected", "expired"];
