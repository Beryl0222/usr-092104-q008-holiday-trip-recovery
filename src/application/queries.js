/**
 * 读侧查询。三类问题各有一个视角，全部由事件重放得到，不另存「真相」：
 *
 * - 旅客视角 customerExplanation：我选了什么、各段保留/改签/拆分/取消原因、价格从哪句承诺来；
 * - 客服视角 agentDashboard：哪里仍悬而未决（待确认方案、待补票、待退款、候补中）；
 * - 争议视角 disputeTrail：每笔资金沿「承诺 → 占位 → 出票/退款事件 → 供应方单号」的完整去向。
 */

import { loadAggregate } from "../domain/aggregates.js";

function allOptions(store) {
  const ids = new Set(
    store.allEvents().filter((e) => e.aggregate_type === "recovery_option").map((e) => e.aggregate_id)
  );
  return [...ids].map((id) => loadAggregate(store, "recovery_option", id));
}

/** 旅客：解释自己看到了什么、选择了什么 */
export function customerExplanation(store, optionId) {
  const option = loadAggregate(store, "recovery_option", optionId);
  const o = option.state;
  if (!o.option_id) throw new Error(`方案不存在：${optionId}`);
  const segments = new Map(
    o.source_segment_ids.map((id) => {
      const agg = loadAggregate(store, "booking_segment", id);
      return [id, agg.state];
    })
  );

  const lines = (o.actions ?? []).map((a) => {
    const seg = segments.get(a.segment_id);
    const head = {
      preserve: "保留",
      rebook: "改签",
      split: "拆分同行",
      cancel: "取消",
    }[a.action];
    return {
      segment_id: a.segment_id,
      kind: seg?.kind ?? null,
      action: a.action,
      headline: `${head}：${a.detail}`,
      added_cost: a.added_cost ?? null,
      lost_entitlement: a.lost_entitlement ?? null,
      expected_refund: a.refund ?? null,
      commitment_id: a.commitment_id ?? null,
      hold_id: a.hold_id ?? null,
      pending_supplier: a.pending_supplier ?? null,
    };
  });

  return {
    option_id: o.option_id,
    status: o.status,
    correlation_id: o.correlation_id,
    frozen_at: o.frozen_at ?? null,
    expires_at: o.expires_at ?? null,
    freeze_summary: o.freeze_summary ?? null,
    chosen: o.chosen ?? null,
    untouched_before_confirmation: (o.actions ?? []).filter((a) => a.action === "preserve").map((a) => a.segment_id),
    segments: lines,
    notification: o.chosen?.notification_id ?? null,
  };
}

/** 客服：还有什么悬而未决 */
export function agentDashboard(store, partyId = null) {
  const parties = partyId
    ? [loadAggregate(store, "travel_party", partyId)]
    : [...new Set(store.allEvents().filter((e) => e.aggregate_type === "travel_party").map((e) => e.aggregate_id))]
        .map((id) => loadAggregate(store, "travel_party", id));

  const dashboard = [];
  for (const party of parties) {
    const open = [];
    for (const segId of party.state.segment_ids) {
      const seg = loadAggregate(store, "booking_segment", segId).state;
      if (seg.status === "waitlisted") open.push({ type: "waitlist_pending", segment_id: segId, supplier: seg.supplier });
      if (seg.refunds.some((r) => r.state === "requested")) {
        open.push({ type: "refund_pending", segment_id: segId, refund_ids: seg.refunds.filter((r) => r.state === "requested").map((r) => r.refund_id) });
      }
    }
    for (const opt of allOptions(store).filter((x) => x.state.party_id === party.aggregateId)) {
      if (["proposed", "frozen"].includes(opt.state.status)) {
        const undelivered = party.state.notifications.filter(
          (n) => n.option_id === opt.aggregateId && n.state !== "delivered"
        );
        open.push({
          type: opt.state.status === "frozen" ? "awaiting_choice" : "awaiting_freeze",
          option_id: opt.aggregateId,
          status: opt.state.status,
          expires_at: opt.state.expires_at ?? null,
          pending_suppliers: opt.state.pending_suppliers ?? [],
          undelivered_notifications: undelivered.map((n) => ({ notification_id: n.notification_id, channel: n.channel, state: n.state })),
        });
      }
    }
    const delivered = party.state.notifications
      .filter((n) => n.state === "delivered")
      .map((n) => ({ notification_id: n.notification_id, channel: n.channel, delivered_at: n.delivered_at, correlation_id: n.correlation_id }));
    dashboard.push({
      party_id: party.aggregateId,
      open_items: open,
      is_clear: open.length === 0,
      notification_delivery: {
        total: party.state.notifications.length,
        delivered,
        failed: party.state.notifications.filter((n) => n.state === "failed").map((n) => ({ notification_id: n.notification_id, channel: n.channel, reason: n.failure })),
      },
      rejected_callbacks: party.state.rejected_callbacks,
    });
  }
  return partyId ? dashboard[0] : dashboard;
}

/** 争议：每笔资金的完整链路 */
export function disputeTrail(store, partyId) {
  const party = loadAggregate(store, "travel_party", partyId);
  const movements = [];
  const segmentIndex = new Map();
  for (const segId of party.state.segment_ids) {
    const seg = loadAggregate(store, "booking_segment", segId);
    segmentIndex.set(segId, seg.state);
    for (const spawn of seg.state.spawns) segmentIndex.set(spawn.segment_id, loadAggregate(store, "booking_segment", spawn.segment_id).state);
  }

  const fr = loadAggregate(store, "financial_resolution", `fr-${partyId}`);
  // 资金事件分布在各段流（退款/出票）与财务流（补款）上，直接扫全库按 party 收集
  const entriesFromEvents = store
    .allEvents()
    .filter((e) => e.payload?.party_id === partyId)
    .flatMap((e) => {
      const p = e.payload;
      if (e.event_type === "REFUND_CONFIRMED") {
        return [{
          entry_id: p.entry_id ?? `refund-${p.refund_id}`,
          type: "refund",
          amount: p.amount.amount,
          currency: p.amount.currency,
          segment_id: e.aggregate_type === "booking_segment" ? e.aggregate_id : null,
          supplier: p.supplier ?? null,
          supplier_ref: p.supplier_ref ?? null,
          refund_id: p.refund_id ?? null,
          label: p.label ?? "退款到账",
          at: e.occurred_at,
          event_id: e.event_id,
        }];
      }
      if (e.event_type === "SUPPLIER_TICKETED") {
        return [{
          entry_id: p.entry_id ?? `charge-${p.supplier_ref}`,
          type: "supplier_charge",
          amount: p.amount.amount,
          currency: p.amount.currency,
          segment_id: e.aggregate_type === "booking_segment" ? e.aggregate_id : null,
          supplier: p.supplier ?? null,
          supplier_ref: p.supplier_ref ?? null,
          commitment_id: p.commitment_id ?? null,
          label: p.label ?? "出票扣款",
          at: e.occurred_at,
          event_id: e.event_id,
        }];
      }
      if (e.event_type === "PAYMENT_COLLECTED") {
        return [{
          entry_id: p.entry_id ?? `pay-${p.payment_id}`,
          type: "payment_collected",
          amount: p.amount.amount,
          currency: p.amount.currency,
          segment_id: null,
          payment_id: p.payment_id ?? null,
          label: p.label ?? "补款",
          at: e.occurred_at,
          event_id: e.event_id,
        }];
      }
      return [];
    });

  for (const entry of entriesFromEvents) {
    const seg = entry.segment_id ? segmentIndex.get(entry.segment_id) : null;
    const trail = {
      entry_id: entry.entry_id,
      type: entry.type,
      amount: { amount: entry.amount, currency: entry.currency },
      at: entry.at,
      event_id: entry.event_id,
      segment_id: entry.segment_id ?? null,
      supplier: entry.supplier ?? null,
      supplier_ref: entry.supplier_ref ?? null,
      refund_id: entry.refund_id ?? null,
      payment_id: entry.payment_id ?? null,
      label: entry.label ?? null,
    };
    // 出票扣款回溯到价格承诺
    if (entry.type === "supplier_charge") {
      trail.commitment = findCommitmentForRef(store, entry.supplier_ref);
      trail.commitment_id = trail.commitment?.commitment_id ?? entry.commitment_id ?? null;
    }
    if (entry.type === "refund") {
      trail.original_booking = seg ? { supplier_ref: seg.supplier_ref, price: seg.price } : null;
    }
    movements.push(trail);
  }

  return {
    party_id: partyId,
    balance: fr.state.balance,
    reconciliation: fr.state.reconciliation ?? null,
    movements,
    open_items: fr.state.reconciliation?.open_items ?? [],
    note: "每笔 movement 的 event_id 可在事件流中定位原文；supplier_ref 为供应方侧单号；commitment 为价格承诺原文。",
  };
}

function findCommitmentForRef(store, supplierRef) {
  // 由新票段的 SUPPLIER_TICKETED 找到 commitment_id，再回到 recovery_option 流找承诺原文
  for (const e of store.allEvents()) {
    if (e.event_type === "SUPPLIER_TICKETED" && e.payload?.supplier_ref === supplierRef) {
      const commitmentId = e.payload.commitment_id;
      for (const c of store.allEvents()) {
        if (c.event_type === "PRICE_COMMITMENT_RECORDED" && c.payload?.commitment?.commitment_id === commitmentId) {
          return c.payload.commitment;
        }
      }
    }
  }
  return null;
}

/** 时间线：协商全过程事件（客服/争议共用） */
export function timeline(store, correlationId) {
  return store
    .allEvents()
    .filter((e) => e.correlation_id === correlationId || e.payload?.correlation_id === correlationId)
    .map((e) => ({
      event_id: e.event_id,
      event_type: e.event_type,
      aggregate_type: e.aggregate_type,
      aggregate_id: e.aggregate_id,
      version: e.version,
      occurred_at: e.occurred_at,
      summary: e.summary,
      causation_id: e.causation_id ?? null,
      idempotency_key: e.idempotency_key ?? null,
    }));
}
