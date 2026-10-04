/**
 * 四个聚合的事件回放投影。纯函数：给定事件数组得到当前状态，不做任何 I/O。
 *
 * 不变量（由命令层在写入前保证，reducer 只忠实投影）：
 * - booking_segment 在被新单替换前始终可查「是否仍有效」，冻结阶段不会改动它；
 * - recovery_option 冻结后持有供应方占位与到期时刻，accepted 之前没有任何有效订单被取消；
 * - financial_resolution 的每一笔都能指回 segment / supplier_ref / price_commitment / 来源事件。
 */

const money = (amount, currency) => ({ amount, currency });

export function reduceTravelParty(events) {
  const s = {
    party_id: null,
    members: [],
    preferences: {},
    contacts: [],
    segment_ids: [],
    notifications: [],
    rejected_callbacks: [],
    correlations: [],
  };
  for (const e of events) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case "PARTY_REGISTERED":
        s.party_id = e.aggregate_id;
        s.members = p.members ?? [];
        s.preferences = p.preferences ?? {};
        s.contacts = p.contacts ?? [];
        break;
      case "SEGMENT_CONFIRMED":
      case "SEGMENT_BOOKED":
        // 团队流上的归属事件用 payload.segment_id；段流自身事件用 aggregate_id
        if (p.segment_id && p.segment_id !== e.aggregate_id) {
          if (!s.segment_ids.includes(p.segment_id)) s.segment_ids.push(p.segment_id);
        } else if (!s.segment_ids.includes(e.aggregate_id)) {
          s.segment_ids.push(e.aggregate_id);
        }
        break;
      case "SEGMENT_SPLIT":
        for (const spawn of p.spawns ?? []) {
          if (!s.segment_ids.includes(spawn.segment_id)) s.segment_ids.push(spawn.segment_id);
        }
        break;
      case "CALLBACK_REJECTED":
        s.rejected_callbacks.push({
          callback_id: p.callback_id,
          supplier: p.supplier,
          reason: p.reason,
          at: e.occurred_at,
          event_id: e.event_id,
        });
        break;
      case "NOTIFICATION_ATTEMPTED":
        s.notifications.push({
          notification_id: p.notification_id,
          option_id: p.option_id ?? null,
          channel: p.channel,
          template: p.template,
          correlation_id: p.correlation_id,
          state: "attempted",
          attempts: [{ at: e.occurred_at, event_id: e.event_id }],
          delivered_at: null,
          failure: null,
        });
        break;
      case "NOTIFICATION_DELIVERED":
      case "NOTIFICATION_FAILED": {
        const n = s.notifications.find((x) => x.notification_id === p.notification_id);
        if (n) {
          n.attempts.push({ at: e.occurred_at, event_id: e.event_id });
          if (e.event_type === "NOTIFICATION_DELIVERED") {
            n.state = "delivered";
            n.delivered_at = e.occurred_at;
          } else {
            n.state = "failed";
            n.failure = p.reason ?? null;
          }
        }
        break;
      }
      default:
        if (p.correlation_id && !s.correlations.includes(p.correlation_id)) {
          s.correlations.push(p.correlation_id);
        }
    }
  }
  return s;
}

export function reduceBookingSegment(events) {
  const s = {
    segment_id: null,
    party_id: null,
    correlation_id: null,
    kind: null,
    supplier: null,
    supplier_ref: null,
    status: null,
    origin: null,
    destination: null,
    dep: null,
    arr: null,
    tz: null,
    price: null,
    passenger_ids: [],
    depends_on: [],
    document_requirement: null,
    disrupted: false,
    disruption: null,
    preserved: false,
    preserve_reason: null,
    parent_segment_id: null,
    spawns: [],
    replaced_by: null,
    replaced_from: null,
    cancelled: null,
    refunds: [],
    tickets: [],
    price_commitments: [],
    price_changes: [],
  };
  for (const e of events) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case "SEGMENT_CONFIRMED":
      case "SEGMENT_BOOKED":
        s.segment_id = e.aggregate_id;
        s.party_id = p.party_id ?? s.party_id;
        s.correlation_id = p.correlation_id ?? s.correlation_id;
        s.kind = p.kind ?? s.kind;
        s.supplier = p.supplier ?? s.supplier;
        s.supplier_ref = p.supplier_ref ?? s.supplier_ref;
        s.status = p.status ?? "booked";
        s.origin = p.origin ?? s.origin;
        s.destination = p.destination ?? s.destination;
        s.dep = p.dep ?? s.dep;
        s.arr = p.arr ?? s.arr;
        s.tz = p.tz ?? s.tz;
        s.price = p.price ?? s.price;
        s.passenger_ids = p.passenger_ids ?? s.passenger_ids;
        s.depends_on = p.depends_on ?? s.depends_on;
        s.document_requirement = p.document_requirement ?? s.document_requirement;
        s.service_date = p.service_date ?? s.service_date;
        s.night_cutoff_minutes = p.night_cutoff_minutes ?? s.night_cutoff_minutes;
        if (p.parent_segment_id) {
          s.parent_segment_id = p.parent_segment_id;
          s.status = s.status ?? "booked";
        }
        break;
      case "DISRUPTION_RECEIVED":
        s.disrupted = true;
        s.correlation_id = p.correlation_id ?? s.correlation_id;
        s.disruption = {
          kind: p.kind, // delay | waitlist_failed | cancellation
          reported_at: e.occurred_at,
          new_dep: p.new_dep ?? null,
          new_arr: p.new_arr ?? null,
          detail: p.detail ?? null,
          callback_id: p.callback_id ?? null,
        };
        if (p.kind === "waitlist_failed") s.status = "failed";
        break;
      case "WAITLIST_RESULT_RECEIVED":
        s.correlation_id = p.correlation_id ?? s.correlation_id;
        if (p.outcome === "confirmed") {
          s.status = "booked";
          if (p.new_dep) s.dep = p.new_dep;
          if (p.new_arr) s.arr = p.new_arr;
          if (p.supplier_ref) s.supplier_ref = p.supplier_ref;
        } else {
          s.status = "failed";
        }
        s.waitlist = { outcome: p.outcome, at: e.occurred_at, detail: p.detail ?? null };
        break;
      case "SEGMENT_PRESERVED":
        s.preserved = true;
        s.preserve_reason = p.reason ?? null;
        break;
      case "SEGMENT_SPLIT":
        s.passenger_ids = p.passenger_ids ?? s.passenger_ids;
        s.spawns.push(...(p.spawns ?? []));
        break;
      case "SUPPLIER_TICKETED":
        s.status = "ticketed";
        s.supplier_ref = p.supplier_ref ?? s.supplier_ref;
        s.tickets.push({
          supplier_ref: p.supplier_ref,
          pnr: p.pnr ?? null,
          amount: p.amount ?? null,
          at: e.occurred_at,
          event_id: e.event_id,
        });
        break;
      case "SEGMENT_REBOOKED":
        s.replaced_by = p.new_segment_id;
        s.status = "cancelled";
        s.cancelled = { reason: p.reason ?? "rebooked", at: e.occurred_at };
        break;
      case "SEGMENT_CANCELLED":
        s.status = "refunded";
        s.cancelled = { reason: p.reason ?? "cancelled", at: e.occurred_at };
        break;
      case "REFUND_REQUESTED":
        s.refunds.push({
          refund_id: p.refund_id,
          state: "requested",
          amount: p.amount ?? null,
          at: e.occurred_at,
          event_id: e.event_id,
        });
        break;
      case "REFUND_CONFIRMED": {
        const r = s.refunds.find((x) => x.refund_id === p.refund_id);
        if (r) {
          r.state = "confirmed";
          r.amount = p.amount ?? r.amount;
          r.confirmed_at = e.occurred_at;
          r.confirm_event_id = e.event_id;
        }
        s.status = "refunded";
        break;
      }
      case "PRICE_COMMITMENT_RECORDED":
        s.price_commitments.push({ ...p.commitment, at: e.occurred_at, event_id: e.event_id });
        break;
      case "SUPPLIER_PRICE_CHANGED":
        s.price_changes.push({
          from: p.from,
          to: p.to,
          commitment_id: p.commitment_id ?? null,
          at: e.occurred_at,
          event_id: e.event_id,
        });
        break;
      default:
        break;
    }
  }
  /** 仍有效订单：没有被替换/取消/退款，候补失败也不算有效。 */
  s.is_valid_order = ["booked", "ticketed", "waitlisted", "hold"].includes(s.status) && !s.replaced_by;
  return s;
}

export function reduceRecoveryOption(events) {
  const s = {
    option_id: null,
    party_id: null,
    correlation_id: null,
    status: null,
    source_segment_ids: [],
    actions: [],
    totals: null,
    holds: [],
    pending_suppliers: [],
    commitments: [],
    expires_at: null,
    frozen_at: null,
    chosen: null,
    notifications: [],
  };
  for (const e of events) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case "OPTION_PROPOSED":
        s.option_id = e.aggregate_id;
        s.party_id = p.party_id;
        s.correlation_id = p.correlation_id;
        s.status = "proposed";
        s.source_segment_ids = p.source_segment_ids ?? [];
        s.actions = p.actions ?? [];
        s.totals = p.totals ?? null;
        s.pending_suppliers = [...new Set((p.actions ?? []).map((a) => a.supplier))];
        break;
      case "OPTION_FROZEN":
        s.status = "frozen";
        s.frozen_at = e.occurred_at;
        s.expires_at = p.expires_at ?? s.expires_at;
        s.totals = p.totals ?? s.totals;
        s.actions = p.actions ?? s.actions;
        s.pending_suppliers = p.pending_suppliers ?? s.pending_suppliers;
        s.freeze_summary = p.summary_text ?? null;
        break;
      case "PRICE_COMMITMENT_RECORDED":
        s.commitments.push({ ...p.commitment, at: e.occurred_at, event_id: e.event_id });
        break;
      case "SUPPLIER_HOLD_PLACED":
        s.holds.push({
          hold_id: p.hold_id,
          supplier: p.supplier,
          segment_id: p.segment_id,
          action: p.action,
          amount: p.amount,
          currency: p.currency,
          expires_at: p.expires_at,
          commitment_id: p.commitment_id ?? null,
          state: "placed",
          at: e.occurred_at,
          event_id: e.event_id,
        });
        break;
      case "SUPPLIER_HOLD_RELEASED": {
        const h = s.holds.find((x) => x.hold_id === p.hold_id);
        if (h) {
          h.state = p.reason === "ticketed" ? "ticketed" : "released";
          h.released_at = e.occurred_at;
        }
        break;
      }
      case "SUPPLIER_PRICE_CHANGED":
        s.price_changed = {
          supplier: p.supplier,
          from: p.from,
          to: p.to,
          commitment_id: p.commitment_id ?? null,
          at: e.occurred_at,
        };
        break;
      case "CHOICE_ACCEPTED":
        s.status = "accepted";
        s.chosen = {
          by: p.by,
          member_ids: p.member_ids ?? null,
          at: e.occurred_at,
          note: p.note ?? null,
          notification_id: p.notification_id ?? null,
        };
        break;
      case "OPTION_REJECTED":
        s.status = "rejected";
        s.rejected = { by: p.by, reason: p.reason ?? null, at: e.occurred_at };
        break;
      case "OPTION_EXPIRED":
        s.status = "expired";
        break;
      case "NOTIFICATION_ATTEMPTED":
      case "NOTIFICATION_DELIVERED":
      case "NOTIFICATION_FAILED":
        if (!s.notifications.includes(p.notification_id)) s.notifications.push(p.notification_id);
        break;
      default:
        break;
    }
  }
  return s;
}

export function reduceFinancialResolution(events) {
  const s = {
    resolution_id: null,
    party_id: null,
    correlation_id: null,
    entries: [],
    holds: [],
  };
  const pushEntry = (e, type) => {
    const p = e.payload ?? {};
    s.entries.push({
      entry_id: p.entry_id ?? `${type}-${e.event_id}`,
      type,
      amount: p.amount,
      currency: p.currency,
      segment_id: p.segment_id ?? null,
      supplier: p.supplier ?? null,
      supplier_ref: p.supplier_ref ?? null,
      commitment_id: p.commitment_id ?? null,
      refund_id: p.refund_id ?? null,
      payment_id: p.payment_id ?? null,
      label: p.label ?? null,
      at: e.occurred_at,
      event_id: e.event_id,
    });
  };
  for (const e of events) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case "OPTION_FROZEN":
        s.resolution_id = s.resolution_id ?? e.aggregate_id;
        s.party_id = s.party_id ?? p.party_id;
        s.correlation_id = s.correlation_id ?? p.correlation_id;
        for (const h of p.holds ?? []) {
          s.holds.push({ ...h, state: "placed", option_id: e.aggregate_id });
        }
        break;
      case "SUPPLIER_HOLD_PLACED":
        s.holds.push({
          hold_id: p.hold_id,
          segment_id: p.segment_id,
          supplier: p.supplier,
          amount: p.amount,
          currency: p.currency,
          state: "placed",
          at: e.occurred_at,
        });
        break;
      case "SUPPLIER_HOLD_RELEASED": {
        const h = s.holds.find((x) => x.hold_id === p.hold_id);
        if (h) h.state = p.reason === "ticketed" ? "ticketed" : "released";
        break;
      }
      case "REFUND_REQUESTED":
        pushEntry(e, "refund_pending");
        break;
      case "REFUND_CONFIRMED":
        pushEntry(e, "refund");
        break;
      case "SUPPLIER_TICKETED":
        pushEntry(e, "supplier_charge");
        break;
      case "PAYMENT_COLLECTED":
        pushEntry(e, "payment_collected");
        break;
      case "FUNDS_RECONCILED": {
        s.resolution_id = e.aggregate_id;
        s.party_id = p.party_id ?? s.party_id;
        s.correlation_id = p.correlation_id ?? s.correlation_id;
        s.reconciliation = {
          totals: p.totals ?? null,
          open_items: p.open_items ?? [],
          at: e.occurred_at,
          event_id: e.event_id,
        };
        break;
      }
      default:
        break;
    }
  }
  // 按币种汇总实际资金（hold 不算资金移动）
  const balance = {};
  for (const x of s.entries) {
    const sign = x.type === "refund" ? 1 : x.type === "payment_collected" ? 1 : -1;
    // refund/payment_collected 为回到旅客侧记正，supplier_charge 为旅客支出记负
    const b = balance[x.currency] ?? money(0, x.currency);
    b.amount = Math.round((b.amount + sign * x.amount) * 100) / 100;
    balance[x.currency] = b;
  }
  s.balance = Object.values(balance);
  return s;
}

export const REDUCERS = {
  travel_party: reduceTravelParty,
  booking_segment: reduceBookingSegment,
  recovery_option: reduceRecoveryOption,
  financial_resolution: reduceFinancialResolution,
};

export function loadAggregate(store, aggregateType, aggregateId) {
  const events = store.load(aggregateType, aggregateId);
  const reducer = REDUCERS[aggregateType];
  if (!reducer) throw new Error(`未知聚合类型：${aggregateType}`);
  return { aggregateType, aggregateId, version: events.length, events, state: reducer(events) };
}
