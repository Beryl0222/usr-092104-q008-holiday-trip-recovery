/**
 * 联程协商应用服务（命令侧）。
 *
 * 它把事件存储、供应方网关、规划器、通知通道编排起来，并强制三条流程铁律：
 *
 * 1. 未确认不替换：freeze 只向供应方要「占位 + 价格承诺」，原有效订单一律不动；
 *    旅客看到的是冻结快照（新增成本/损失权益/待确认供应方/到期时刻）。
 * 2. 确认后先立后破：accept 先把占位出成新票、新单 SEGMENT_BOOKED 落账，
 *    才取消旧单（SEGMENT_REBOOKED/SEGMENT_CANCELLED）并申请退款，
 *    任何一步失败都不会留下「旧单已退、新单没有」的状态。
 * 3. 幂等：出站请求带确定性幂等键；入站回调按 callback_id 去重；
 *    领域事件按 event_id 去重——重复回调不可能二次占位或二次退款。
 */

import { EventStore } from "../domain/store.js";
import { loadAggregate } from "../domain/aggregates.js";
import { planRecovery } from "../domain/planner.js";
import { SupplierGateway, SupplierError } from "../suppliers/gateway.js";

const ISO = (d) => d.toISOString();

export class RecoveryService {
  constructor({
    store = new EventStore(),
    gateway = new SupplierGateway(),
    channels = {},
    now = () => new Date(),
    idFactory = null,
    holdTtlMs = 30 * 60_000,
  } = {}) {
    this.store = store;
    this.gateway = gateway;
    this.channels = channels; // { sms: async(msg)=>({provider_id}), email: ..., push: ... }
    this.now = now;
    this.holdTtlMs = holdTtlMs;
    let seq = 0;
    this.#nextId = idFactory ?? ((prefix) => `${prefix}-${String(++seq).padStart(4, "0")}`);
  }
  #nextId;

  #append(aggregateType, aggregateId, eventType, payload, { expectedVersion, correlationId, causationId, idempotencyKey, summary } = {}) {
    const version = this.store.streamVersion(aggregateType, aggregateId) + 1;
    const event = {
      event_id: this.#nextId("evt"),
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: ISO(this.now()),
      version,
      summary: summary ?? eventType,
      payload: { ...(correlationId ? { correlation_id: correlationId } : {}), ...payload },
    };
    if (causationId) event.causation_id = causationId;
    if (idempotencyKey) event.idempotency_key = idempotencyKey;
    return this.store.append(event, expectedVersion ?? version - 1);
  }

  // ---------------- 团队与行程建档 ----------------
  registerParty({ party_id, members, preferences = {}, contacts = [], correlation_id }) {
    if (this.store.streamVersion("travel_party", party_id) > 0) {
      return loadAggregate(this.store, "travel_party", party_id);
    }
    this.#append("travel_party", party_id, "PARTY_REGISTERED", {
      party_id, members, preferences, contacts, correlation_id,
    }, { expectedVersion: 0, correlationId: correlation_id, summary: `登记同行团队 ${party_id}` });
    return loadAggregate(this.store, "travel_party", party_id);
  }

  registerSegment(seg) {
    const {
      segment_id, party_id, kind, supplier, supplier_ref, price,
      origin, destination, dep, arr, tz, passenger_ids, depends_on = [],
      document_requirement = null, service_date = null, night_cutoff_minutes = null,
      status = "booked", correlation_id,
    } = seg;
    if (this.store.streamVersion("booking_segment", segment_id) > 0) {
      return loadAggregate(this.store, "booking_segment", segment_id);
    }
    this.#append("booking_segment", segment_id, "SEGMENT_BOOKED", {
      party_id, kind, supplier, supplier_ref, status,
      origin, destination, dep, arr, tz, price, passenger_ids, depends_on,
      document_requirement, service_date, night_cutoff_minutes,
    }, { expectedVersion: 0, correlationId: correlation_id, summary: `登记行程段 ${kind}:${segment_id}` });
    // 在团队流上登记归属（party 聚合据此维护 segment 索引）
    this.#append("travel_party", party_id, "SEGMENT_CONFIRMED", {
      party_id, segment_id, kind, supplier, supplier_ref, correlation_id,
    }, { correlationId: correlation_id, summary: `团队行程纳入 ${kind}:${segment_id}` });
    this.gateway.registerBooking({
      supplier_ref, supplier, kind, amount: price?.amount, currency: price?.currency,
      status: status === "waitlisted" ? "waitlisted" : "booked", passengers: passenger_ids,
    });
    return loadAggregate(this.store, "booking_segment", segment_id);
  }

  // ---------------- 入站回调（去重入口） ----------------
  /**
   * 统一供应方回调入口。返回 {duplicate, applied?}。
   * 重复 callback_id 直接回传首次结论，不再产生任何事件或供应方副作用。
   */
  receiveSupplierCallback(cb) {
    try {
      const result = this.gateway.ingestCallback(cb, (c) => this.#applyCallback(c));
      return result;
    } catch (err) {
      // 无法识别/无法处理的回调：登记 CALLBACK_REJECTED，绝不假装处理成功
      const partyId = cb.party_id ?? "unknown-party";
      if (cb.party_id) {
        this.#append("travel_party", partyId, "CALLBACK_REJECTED", {
          callback_id: cb.callback_id, supplier: cb.supplier ?? null,
          supplier_ref: cb.supplier_ref ?? null, reason: err.message,
        }, { summary: `拒绝供应方回调：${err.message}` });
      }
      return { duplicate: false, rejected: true, reason: err.message };
    }
  }

  #applyCallback(cb) {
    const eventId = `evt-cb-${cb.callback_id}`; // 确定性事件 id：即使去重表被绕过，存储仍拒绝第二次
    if (cb.type === "waitlist_result") {
      const outcome = cb.outcome === "confirmed" ? "confirmed" : "failed";
      this.gateway.setWaitlistOutcome(cb.supplier_ref, outcome);
      const booking = this.gateway.getBooking(cb.supplier_ref);
      const segment = this.#findSegmentByRef(cb.supplier_ref);
      if (!segment) throw new SupplierError("UNKNOWN_SEGMENT", `找不到供应方订单 ${cb.supplier_ref} 对应的行程段`);
      this.#appendWithEventId(eventId, "booking_segment", segment.segment_id, "WAITLIST_RESULT_RECEIVED", {
        party_id: segment.party_id,
        correlation_id: cb.correlation_id ?? segment.correlation_id,
        callback_id: cb.callback_id,
        outcome,
        supplier_ref: cb.supplier_ref,
        new_dep: cb.new_dep ?? null,
        new_arr: cb.new_arr ?? null,
        detail: cb.detail ?? null,
      }, { summary: `候补结果：${outcome === "confirmed" ? "成功" : "失败"} ${cb.supplier_ref}` });
      return { applied: true, kind: "waitlist_result", outcome, segment_id: segment.segment_id };
    }
    if (cb.type === "disruption") {
      const segment = this.#findSegmentByRef(cb.supplier_ref);
      if (!segment) throw new SupplierError("UNKNOWN_SEGMENT", `找不到供应方订单 ${cb.supplier_ref} 对应的行程段`);
      this.#appendWithEventId(eventId, "booking_segment", segment.segment_id, "DISRUPTION_RECEIVED", {
        party_id: segment.party_id,
        correlation_id: cb.correlation_id ?? segment.correlation_id,
        callback_id: cb.callback_id,
        kind: cb.kind ?? "delay",
        new_dep: cb.new_dep ?? null,
        new_arr: cb.new_arr ?? null,
        detail: cb.detail ?? null,
      }, { summary: `收到中断：${cb.kind ?? "delay"} ${cb.supplier_ref}` });
      return { applied: true, kind: "disruption", segment_id: segment.segment_id };
    }
    throw new SupplierError("UNKNOWN_CALLBACK_TYPE", `未知回调类型：${cb.type}`);
  }

  #appendWithEventId(eventId, aggregateType, aggregateId, eventType, payload, opts = {}) {
    const version = this.store.streamVersion(aggregateType, aggregateId) + 1;
    const event = {
      event_id: eventId,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: ISO(this.now()),
      version,
      summary: opts.summary ?? eventType,
      payload: { ...payload },
    };
    if (opts.causationId) event.causation_id = opts.causationId;
    return this.store.append(event, version - 1);
  }

  #findSegmentByRef(supplierRef) {
    const party = this.#allParties();
    for (const partyId of party) {
      const agg = loadAggregate(this.store, "travel_party", partyId);
      for (const segmentId of agg.state.segment_ids) {
        const seg = loadAggregate(this.store, "booking_segment", segmentId);
        if (seg.state.supplier_ref === supplierRef) return { ...seg.state, party_id: partyId };
      }
    }
    return null;
  }

  #allParties() {
    return [...new Set(
      this.store.allEvents().filter((e) => e.aggregate_type === "travel_party").map((e) => e.aggregate_id)
    )];
  }

  // ---------------- 规划与提案 ----------------
  propose({ party_id, correlation_id, disruption, alternatives = [], refundPolicies = {}, mctOverrides = null }) {
    const party = loadAggregate(this.store, "travel_party", party_id).state;
    const segments = party.segment_ids.map((id) => loadAggregate(this.store, "booking_segment", id).state);
    const plan = planRecovery({ party, segments, disruption, alternatives, refundPolicies, mctOverrides });

    const option_id = this.#nextId("opt");
    const recommended = plan.options.find((o) => o.recommended) ?? plan.options[0];
    this.#append("recovery_option", option_id, "OPTION_PROPOSED", {
      party_id,
      correlation_id,
      source_segment_ids: segments.map((s) => s.segment_id),
      impacts: plan.impacts,
      document_splits: plan.document_splits,
      options: plan.options.map(({ actions, totals, pending_suppliers: ps, untouched_valid_orders: u, ...rest }) => ({
        ...rest,
        actions,
        totals,
        pending_suppliers: ps,
        untouched_valid_orders: u,
      })),
      actions: recommended.actions,
      totals: recommended.totals,
    }, { correlationId: correlation_id, summary: `提出 ${plan.options.length} 个恢复方案，推荐「${recommended.title}」` });
    return { option_id, plan };
  }

  // ---------------- 冻结：占位 + 价格承诺，不动有效订单 ----------------
  freeze({ option_id, ttlMs = this.holdTtlMs }) {
    const option = loadAggregate(this.store, "recovery_option", option_id);
    if (option.state.status !== "proposed") {
      throw new Error(`方案 ${option_id} 当前状态 ${option.state.status}，仅 proposed 可冻结`);
    }
    const corr = option.state.correlation_id;
    const partyId = option.state.party_id;
    const frozenActions = [];
    const holds = [];
    const commitments = [];
    const pending = new Set(option.state.pending_suppliers);

    option.state.actions.forEach((action, index) => {
      const annotated = structuredClone(action);
      const alt = action.alternative;
      if ((action.action === "rebook" || action.action === "split") && alt) {
        const passengerIds = action.action === "split" ? action.keep_passenger_ids : this.#segmentPassengers(action.segment_id);
        // 1) 价格承诺
        const quote = this.gateway.quotePrice({
          supplier: alt.supplier,
          amount: alt.price.amount,
          currency: alt.price.currency,
          ttlMs,
          idempotencyKey: `quote:${option_id}:${index}`,
          meta: { segment_id: action.segment_id, alternative_id: alt.alternative_id },
        });
        commitments.push(quote);
        this.#append("recovery_option", option_id, "PRICE_COMMITMENT_RECORDED", {
          party_id: partyId,
          commitment: quote,
        }, { correlationId: corr, idempotencyKey: `quote:${option_id}:${index}`, summary: `价格承诺 ${alt.supplier} ${quote.amount}${quote.currency}，有效期至 ${quote.valid_until}` });

        // 2) 占位（只占新资源，绝不碰旧单）
        const { hold, price_changed } = this.gateway.placeHold({
          supplier: alt.supplier,
          kind: action.action === "split" ? "split" : this.#segmentKind(action.segment_id),
          passengers: passengerIds,
          amount: alt.price.amount,
          currency: alt.price.currency,
          ttlMs,
          commitment_id: quote.commitment_id,
          idempotencyKey: `hold:${option_id}:${index}`,
          segment_id: action.segment_id,
        });
        holds.push(hold);
        annotated.hold_id = hold.hold_id;
        annotated.commitment_id = quote.commitment_id;
        annotated.added_cost = { amount: hold.amount, currency: hold.currency };
        if (price_changed) {
          this.#append("recovery_option", option_id, "SUPPLIER_PRICE_CHANGED", {
            party_id: partyId,
            supplier: alt.supplier,
            from: { amount: price_changed.from, currency: alt.price.currency },
            to: { amount: price_changed.to, currency: alt.price.currency },
            commitment_id: quote.commitment_id,
          }, { correlationId: corr, summary: `供应方现价变动，仍按承诺价 ${hold.amount}${hold.currency} 结算` });
        }
        this.#append("recovery_option", option_id, "SUPPLIER_HOLD_PLACED", {
          party_id: partyId,
          hold_id: hold.hold_id,
          supplier: hold.supplier,
          segment_id: action.segment_id,
          action: action.action,
          amount: { amount: hold.amount, currency: hold.currency },
          currency: hold.currency,
          expires_at: hold.expires_at,
          commitment_id: quote.commitment_id,
        }, { correlationId: corr, idempotencyKey: `hold:${option_id}:${index}`, summary: `冻结占位 ${hold.hold_id}（${alt.supplier}），确认前不替换原订单` });
      }
      if (action.pending_supplier) pending.add(action.pending_supplier);
      frozenActions.push(annotated);
    });

    const expiresAt = holds.length
      ? new Date(Math.min(...holds.map((h) => new Date(h.expires_at).getTime()))).toISOString()
      : new Date(this.now().getTime() + ttlMs).toISOString();

    const totals = this.#recalcTotals(frozenActions);
    this.#append("recovery_option", option_id, "OPTION_FROZEN", {
      party_id: partyId,
      actions: frozenActions,
      holds: holds.map((h) => ({
        hold_id: h.hold_id, supplier: h.supplier, segment_id: h.segment_id,
        amount: { amount: h.amount, currency: h.currency }, expires_at: h.expires_at,
        commitment_id: h.commitment_id,
      })),
      totals,
      pending_suppliers: [...pending],
      untouched_valid_orders: option.state.actions.filter((a) => a.action === "preserve").map((a) => a.segment_id),
      expires_at: expiresAt,
      summary_text: this.#freezeSummaryText(frozenActions, totals, [...pending], expiresAt),
    }, { correlationId: corr, summary: `方案已冻结，${holds.length} 个占位，到期 ${expiresAt}；原有效订单保持不变` });

    return loadAggregate(this.store, "recovery_option", option_id);
  }

  #recalcTotals(actions) {
    const add = (acc, m) => {
      if (!m) return acc;
      const cur = acc.find((x) => x.currency === m.currency);
      if (cur) cur.amount = Math.round((cur.amount + m.amount) * 100) / 100;
      else acc.push({ amount: m.amount, currency: m.currency });
      return acc;
    };
    const added = [], lost = [], refunds = [];
    for (const a of actions) {
      if (a.added_cost) add(added, a.added_cost);
      if (a.lost_entitlement) add(lost, a.lost_entitlement);
      if (a.refund) add(refunds, a.refund);
    }
    return { added_cost: added, lost_entitlement: lost, expected_refund: refunds };
  }

  #freezeSummaryText(actions, totals, pendingSuppliers, expiresAt) {
    const preserve = actions.filter((a) => a.action === "preserve").length;
    const rebook = actions.filter((a) => a.action === "rebook").length;
    const split = actions.filter((a) => a.action === "split").length;
    const cancel = actions.filter((a) => a.action === "cancel").length;
    const fmt = (list) => list.map((m) => `${m.amount} ${m.currency}`).join("、") || "无";
    return [
      `保留 ${preserve} 段、改签 ${rebook} 段、拆分 ${split} 段、取消 ${cancel} 段；`,
      `新增成本 ${fmt(totals.added_cost)}；损失权益 ${fmt(totals.lost_entitlement)}；预计退回 ${fmt(totals.expected_refund)}；`,
      `待确认供应方：${pendingSuppliers.join("、") || "无"}；占位到期 ${expiresAt}；`,
      "确认前所有仍有效订单不会被改动。",
    ].join("");
  }

  #segmentPassengers(segmentId) {
    return loadAggregate(this.store, "booking_segment", segmentId).state.passenger_ids;
  }
  #segmentKind(segmentId) {
    return loadAggregate(this.store, "booking_segment", segmentId).state.kind;
  }

  // ---------------- 通知：尝试与真实送达 ----------------
  async notifyFrozen({ option_id, channel, template = "option_frozen", to = null }) {
    const option = loadAggregate(this.store, "recovery_option", option_id);
    if (!["frozen", "accepted"].includes(option.state.status)) {
      throw new Error("只能对已冻结方案发送通知");
    }
    const party = loadAggregate(this.store, "travel_party", option.state.party_id);
    const target = to ?? party.state.contacts.find((c) => c.channel === channel)?.address;
    if (!target) throw new Error(`团队没有 ${channel} 通知地址`);
    const sender = this.channels[channel];
    if (!sender) throw new Error(`未配置通道：${channel}`);

    const notification_id = this.#nextId("ntf");
    const message = {
      notification_id, option_id, channel, to: target, template,
      correlation_id: option.state.correlation_id,
      summary: option.state.freeze_summary,
      expires_at: option.state.expires_at,
    };
    this.#append("travel_party", party.aggregateId, "NOTIFICATION_ATTEMPTED", {
      notification_id, option_id, channel, to: target, template,
      correlation_id: option.state.correlation_id,
    }, { correlationId: option.state.correlation_id, summary: `通知尝试 ${channel} → ${target}` });

    try {
      const receipt = await sender(message);
      this.#append("travel_party", party.aggregateId, "NOTIFICATION_DELIVERED", {
        notification_id, option_id, channel,
        provider_message_id: receipt?.provider_id ?? null,
        delivered_detail: receipt?.detail ?? null,
      }, { correlationId: option.state.correlation_id, causationId: notification_id, summary: `通知已送达：${receipt?.provider_id ?? "provider"}` });
      return { notification_id, state: "delivered", receipt };
    } catch (err) {
      this.#append("travel_party", party.aggregateId, "NOTIFICATION_FAILED", {
        notification_id, option_id, channel, reason: err.message,
      }, { correlationId: option.state.correlation_id, causationId: notification_id, summary: `通知送达失败：${err.message}` });
      return { notification_id, state: "failed", reason: err.message };
    }
  }

  // ---------------- 接受：先出新票，再退旧单 ----------------
  accept({ option_id, by, note = null, notification_id = null }) {
    const option = loadAggregate(this.store, "recovery_option", option_id);
    if (option.state.status !== "frozen") throw new Error(`方案 ${option_id} 状态为 ${option.state.status}，须先冻结`);
    if (this.now().getTime() > new Date(option.state.expires_at).getTime()) {
      const err = new Error("占位已到期，请重新冻结后再确认");
      err.code = "OPTION_EXPIRED";
      throw err;
    }
    if (notification_id) this.#assertDelivered(option.state.party_id, notification_id);

    const corr = option.state.correlation_id;
    const partyId = option.state.party_id;
    const actions = option.state.actions;

    // 阶段 1：所有占位先出票、新单先建档。任何失败都在取消旧单之前抛出。
    const tickets = [];
    for (const action of actions) {
      if (!action.hold_id) continue;
      const { supplier_ref, hold } = this.gateway.ticketHold({
        hold_id: action.hold_id,
        idempotencyKey: `ticket:${action.hold_id}`,
      });
      const alt = action.alternative;
      const passengers = action.action === "split" ? action.keep_passenger_ids : this.#segmentPassengers(action.segment_id);
      const newSegmentId = this.#nextId("seg");
      this.#append("booking_segment", newSegmentId, "SEGMENT_BOOKED", {
        party_id: partyId,
        kind: this.#segmentKind(action.segment_id),
        supplier: hold.supplier,
        supplier_ref,
        status: "ticketed",
        origin: alt?.origin ?? this.#originOf(action.segment_id),
        destination: alt?.destination ?? this.#destinationOf(action.segment_id),
        dep: alt?.dep ?? null,
        arr: alt?.arr ?? null,
        price: { amount: hold.amount, currency: hold.currency },
        passenger_ids: passengers,
        depends_on: [],
        parent_segment_id: action.segment_id,
        replaced_for: action.action,
      }, { correlationId: corr, summary: `新单先出票 ${supplier_ref}（占位 ${hold.hold_id}）` });
      this.#append("travel_party", partyId, "SEGMENT_CONFIRMED", {
        party_id: partyId, segment_id: newSegmentId, kind: this.#segmentKind(action.segment_id),
        supplier: hold.supplier, supplier_ref, correlation_id: corr, parent_segment_id: action.segment_id,
      }, { correlationId: corr, summary: `团队行程纳入新单 ${newSegmentId}` });
      this.#append("booking_segment", newSegmentId, "SUPPLIER_TICKETED", {
        party_id: partyId,
        supplier: hold.supplier,
        supplier_ref,
        hold_id: hold.hold_id,
        commitment_id: hold.commitment_id ?? null,
        amount: { amount: hold.amount, currency: hold.currency },
        pnr: supplier_ref,
        entry_id: `charge-${supplier_ref}`,
        label: `新票出票 ${hold.supplier}`,
      }, { correlationId: corr, idempotencyKey: `ticket:${hold.hold_id}`, summary: `供应方扣款/出票 ${supplier_ref} ${hold.amount}${hold.currency}` });
      this.gateway.releaseHold({ hold_id: hold.hold_id, reason: "ticketed", idempotencyKey: `release:${hold.hold_id}` });
      this.#append("recovery_option", option_id, "SUPPLIER_HOLD_RELEASED", {
        party_id: partyId, hold_id: hold.hold_id, reason: "ticketed", new_segment_id: newSegmentId,
      }, { correlationId: corr, summary: `占位转出票 ${hold.hold_id}` });
      tickets.push({ action, newSegmentId, supplier_ref, hold });
    }

    // 阶段 2：登记旅客选择（发生在任何旧单取消之前，记录「看到了什么、选了什么」）
    this.#append("recovery_option", option_id, "CHOICE_ACCEPTED", {
      party_id: partyId,
      by,
      note,
      notification_id,
      frozen_totals: option.state.totals,
      freeze_summary: option.state.freeze_summary,
      accepted_actions: actions.map((a) => ({
        segment_id: a.segment_id, action: a.action,
        hold_id: a.hold_id ?? null, added_cost: a.added_cost ?? null,
        lost_entitlement: a.lost_entitlement ?? null,
      })),
    }, { correlationId: corr, summary: `${by} 确认方案，冻结快照已存档` });

    // 阶段 3：新单全部就位后，再处理旧单
    const refunds = [];
    for (const ticket of tickets) {
      const { action, newSegmentId } = ticket;
      const old = loadAggregate(this.store, "booking_segment", action.segment_id);
      if (action.action === "split") {
        this.#append("booking_segment", action.segment_id, "SEGMENT_SPLIT", {
          party_id: partyId,
          passenger_ids: action.split_passenger_ids,
          spawns: [{ segment_id: newSegmentId, passenger_ids: action.keep_passenger_ids }],
        }, { correlationId: corr, summary: `拆分同行：合格成员走新单 ${newSegmentId}，受限成员 ${action.split_passenger_ids.join("、")} 拆出` });
        // 有备选时旧 PNR 整体换开，按方案快照的全额可退金额退回
        const refund = this.#refundOld(old.state, corr, partyId, action);
        if (refund) refunds.push(refund);
      } else {
        this.#append("booking_segment", action.segment_id, "SEGMENT_REBOOKED", {
          party_id: partyId,
          new_segment_id: newSegmentId,
          reason: "中断改签：新票已出票后替换旧单",
        }, { correlationId: corr, summary: `旧单被新单 ${newSegmentId} 替换` });
        const refund = this.#refundOld(old.state, corr, partyId, action);
        if (refund) refunds.push(refund);
      }
    }
    // 纯取消动作（无占位的）
    for (const action of actions) {
      if (action.action !== "cancel" || action.hold_id) continue;
      const seg = loadAggregate(this.store, "booking_segment", action.segment_id).state;
      this.#append("booking_segment", seg.segment_id, "SEGMENT_CANCELLED", {
        party_id: partyId, reason: action.detail, passenger_ids: action.passenger_ids ?? seg.passenger_ids,
      }, { correlationId: corr, summary: `取消段 ${seg.segment_id}` });
      if (seg.supplier_ref && seg.is_valid_order !== false && seg.status !== "failed") {
        const refund = this.#refundOld(seg, corr, partyId, action);
        if (refund) refunds.push(refund);
      }
    }
    // 拆分但暂无备选：合格成员维持候补/人工跟进，受限成员名额先按规则退款
    for (const action of actions) {
      if (action.action !== "split" || action.hold_id) continue;
      const old = loadAggregate(this.store, "booking_segment", action.segment_id);
      this.#append("booking_segment", action.segment_id, "SEGMENT_SPLIT", {
        party_id: partyId,
        passenger_ids: action.split_passenger_ids,
        spawns: [],
        note: "暂无可售备选，合格成员保留后续跟进",
      }, { correlationId: corr, summary: `拆分同行：受限成员 ${action.split_passenger_ids.join("、")} 拆出待人工安排` });
      const refund = this.#refundPortion(action, old.state, corr, partyId, "split 后受限成员名额退款");
      if (refund) refunds.push(refund);
    }

    // 保留动作留痕
    for (const action of actions) {
      if (action.action !== "preserve") continue;
      this.#append("booking_segment", action.segment_id, "SEGMENT_PRESERVED", {
        party_id: partyId, reason: action.detail,
      }, { correlationId: corr, summary: `确认保留仍有效段 ${action.segment_id}` });
    }

    // 阶段 4：收取净补款（新票扣款减去已退回旧单），随后对账
    const charges = tickets.map((t) => ({ amount: t.hold.amount, currency: t.hold.currency, supplier_ref: t.supplier_ref }));
    const due = this.#netDue(charges, refunds.map((r) => ({ amount: r.amount, currency: r.currency })));
    for (const m of due) {
      if (m.amount <= 0) continue;
      const payment_id = this.#nextId("pay");
      this.#append("financial_resolution", this.#frId(partyId), "PAYMENT_COLLECTED", {
        party_id: partyId, payment_id, option_id,
        amount: m, currency: m.currency,
        entry_id: `pay-${payment_id}`,
        label: "旅客补差价（新增成本减退款）",
      }, { correlationId: corr, idempotencyKey: `pay:${option_id}:${m.currency}`, summary: `收取补款 ${m.amount} ${m.currency}` });
    }

    return this.reconcile({ party_id: partyId, correlation_id: corr, option_id });
  }

  #frId(partyId) {
    return `fr-${partyId}`;
  }

  #assertDelivered(partyId, notificationId) {
    const party = loadAggregate(this.store, "travel_party", partyId).state;
    const n = party.notifications.find((x) => x.notification_id === notificationId);
    if (!n) throw new Error(`通知 ${notificationId} 不存在，不能作为知情依据`);
    if (n.state !== "delivered") throw new Error(`通知 ${notificationId} 状态为 ${n.state}，未真正送达，不能据此确认`);
  }

  #originOf(segmentId) { return loadAggregate(this.store, "booking_segment", segmentId).state.origin; }
  #destinationOf(segmentId) { return loadAggregate(this.store, "booking_segment", segmentId).state.destination; }

  #refundOld(seg, corr, partyId, action = null) {
    // action.refund 为 null 表示该段没有已付可退（如候补未出票）：一分钱都不退
    if (action && action.refund === null) return null;
    const policyRefund = action?.refund ?? null;
    const refundAmount = policyRefund?.amount ?? (seg.price ? seg.price.amount : 0);
    const currency = policyRefund?.currency ?? seg.price?.currency;
    if (!seg.supplier_ref || refundAmount <= 0) {
      // 无可退：损失权益已在方案快照中，这里不制造空退款
      return null;
    }
    const refund = this.gateway.requestRefund({
      supplier_ref: seg.supplier_ref,
      amount: refundAmount,
      currency,
      reason: "联程恢复：旧单替换/取消",
      idempotencyKey: `refund:${seg.supplier_ref}`,
    });
    this.#append("booking_segment", seg.segment_id, "REFUND_REQUESTED", {
      party_id: partyId,
      refund_id: refund.refund_id,
      supplier: refund.supplier,
      supplier_ref: refund.supplier_ref,
      amount: { amount: refund.amount, currency: refund.currency },
      currency: refund.currency,
      entry_id: `refpend-${refund.refund_id}`,
      label: "旧单退款申请",
    }, { correlationId: corr, idempotencyKey: `refund:${seg.supplier_ref}`, summary: `申请退款 ${refund.refund_id}` });
    this.#append("booking_segment", seg.segment_id, "REFUND_CONFIRMED", {
      party_id: partyId,
      refund_id: refund.refund_id,
      supplier: refund.supplier,
      supplier_ref: refund.supplier_ref,
      amount: { amount: refund.amount, currency: refund.currency },
      currency: refund.currency,
      entry_id: `refund-${refund.refund_id}`,
      label: "旧单退款到账",
    }, { correlationId: corr, summary: `退款确认 ${refund.refund_id} ${refund.amount}${refund.currency}` });
    return refund;
  }

  #refundPortion(action, seg, corr, partyId, label) {
    // 简化模型：受限成员名额按方案快照中的 refund 金额退；供应方侧该订单按一次幂等退款处理
    if (!action.refund || action.refund.amount <= 0 || !seg.supplier_ref) return null;
    const refund = this.gateway.requestRefund({
      supplier_ref: seg.supplier_ref,
      amount: action.refund.amount,
      currency: action.refund.currency,
      reason: label,
      idempotencyKey: `refund:${seg.supplier_ref}:split`,
      partial: true, // 仅退受限成员名额，合格成员的旧单由新票替换流程处理
    });
    this.#append("booking_segment", seg.segment_id, "REFUND_REQUESTED", {
      party_id: partyId, refund_id: refund.refund_id, supplier: refund.supplier, supplier_ref: refund.supplier_ref,
      amount: { amount: refund.amount, currency: refund.currency }, currency: refund.currency,
      passenger_ids: action.split_passenger_ids, entry_id: `refpend-${refund.refund_id}`, label,
    }, { correlationId: corr, idempotencyKey: `refund:${seg.supplier_ref}:split`, summary: `拆分名额退款申请 ${refund.refund_id}` });
    this.#append("booking_segment", seg.segment_id, "REFUND_CONFIRMED", {
      party_id: partyId, refund_id: refund.refund_id, supplier: refund.supplier, supplier_ref: refund.supplier_ref,
      amount: { amount: refund.amount, currency: refund.currency }, currency: refund.currency,
      passenger_ids: action.split_passenger_ids, entry_id: `refund-${refund.refund_id}`, label: `${label}（到账）`,
    }, { correlationId: corr, summary: `拆分名额退款到账 ${refund.refund_id}` });
    return refund;
  }

  #netDue(charges, refunds) {
    const byCur = new Map();
    for (const c of charges) {
      const cur = byCur.get(c.currency) ?? { amount: 0, currency: c.currency };
      cur.amount += c.amount;
      byCur.set(c.currency, cur);
    }
    for (const r of refunds) {
      const cur = byCur.get(r.currency) ?? { amount: 0, currency: r.currency };
      cur.amount -= r.amount;
      byCur.set(r.currency, cur);
    }
    return [...byCur.values()].map((m) => ({ ...m, amount: Math.round(m.amount * 100) / 100 }));
  }

  // ---------------- 拒绝/过期：释放占位 ----------------
  reject({ option_id, by, reason = null }) {
    const option = loadAggregate(this.store, "recovery_option", option_id);
    if (!["frozen", "proposed"].includes(option.state.status)) throw new Error("当前状态不可拒绝");
    this.#releaseAllHolds(option_id, option.state, option.state.correlation_id, "旅客拒绝方案");
    this.#append("recovery_option", option_id, "OPTION_REJECTED", {
      party_id: option.state.party_id, by, reason,
    }, { correlationId: option.state.correlation_id, summary: `${by} 拒绝方案，全部占位已释放` });
    return loadAggregate(this.store, "recovery_option", option_id);
  }

  expireIfDue(optionId = null) {
    const ids = optionId
      ? [optionId]
      : [...new Set(this.store.allEvents().filter((e) => e.aggregate_type === "recovery_option").map((e) => e.aggregate_id))];
    const expired = [];
    for (const id of ids) {
      const option = loadAggregate(this.store, "recovery_option", id);
      if (option.state.status === "frozen" && this.now().getTime() > new Date(option.state.expires_at).getTime()) {
        this.#releaseAllHolds(id, option.state, option.state.correlation_id, "占位到期");
        this.#append("recovery_option", id, "OPTION_EXPIRED", {
          party_id: option.state.party_id,
        }, { correlationId: option.state.correlation_id, summary: "冻结到期未确认，占位释放，原订单不受影响" });
        expired.push(id);
      }
    }
    return expired;
  }

  #releaseAllHolds(optionId, state, corr, reason) {
    for (const h of state.holds ?? []) {
      if (h.state !== "placed") continue;
      this.gateway.releaseHold({ hold_id: h.hold_id, reason: "released", idempotencyKey: `release:${h.hold_id}` });
      this.#append("recovery_option", optionId, "SUPPLIER_HOLD_RELEASED", {
        party_id: state.party_id, hold_id: h.hold_id, reason: "released",
      }, { correlationId: corr, summary: `释放占位 ${h.hold_id}（${reason}）` });
    }
  }

  // ---------------- 对账 ----------------
  reconcile({ party_id, correlation_id, option_id = null }) {
    const events = this.store.allEvents().filter(
      (e) => e.payload?.party_id === party_id && (!correlation_id || e.payload?.correlation_id === correlation_id || e.correlation_id === correlation_id)
    );
    const entries = [];
    for (const e of events) {
      if (e.event_type === "REFUND_CONFIRMED") {
        entries.push({ direction: "in", kind: "refund", amount: e.payload.amount, supplier_ref: e.payload.supplier_ref, segment_id: e.aggregate_id, event_id: e.event_id, at: e.occurred_at, label: e.payload.label ?? "退款" });
      } else if (e.event_type === "SUPPLIER_TICKETED") {
        entries.push({ direction: "out", kind: "supplier_charge", amount: e.payload.amount, supplier_ref: e.payload.supplier_ref, segment_id: e.aggregate_id, commitment_id: e.payload.commitment_id ?? null, event_id: e.event_id, at: e.occurred_at, label: e.payload.label ?? "出票扣款" });
      } else if (e.event_type === "PAYMENT_COLLECTED") {
        entries.push({ direction: "in", kind: "payment_collected", amount: e.payload.amount, payment_id: e.payload.payment_id, event_id: e.event_id, at: e.occurred_at, label: e.payload.label ?? "补款" });
      }
    }
    // 未决项：占用未释放/无退款结果/方案仍冻结
    const openItems = [];
    const optionAgg = option_id ? loadAggregate(this.store, "recovery_option", option_id) : null;
    if (optionAgg?.state.status === "frozen") openItems.push({ type: "awaiting_choice", option_id });
    for (const segId of loadAggregate(this.store, "travel_party", party_id).state.segment_ids) {
      const seg = loadAggregate(this.store, "booking_segment", segId).state;
      if (seg.status === "waitlisted") openItems.push({ type: "waitlist_pending", segment_id: segId, supplier: seg.supplier });
    }

    const totalsByCur = new Map();
    for (const x of entries) {
      const sign = x.direction === "in" ? 1 : -1;
      const cur = totalsByCur.get(x.amount.currency) ?? { amount: 0, currency: x.amount.currency };
      cur.amount = Math.round((cur.amount + sign * x.amount.amount) * 100) / 100;
      totalsByCur.set(x.amount.currency, cur);
    }
    const balanced = [...totalsByCur.values()].every((m) => m.amount === 0);

    this.#append("financial_resolution", this.#frId(party_id), "FUNDS_RECONCILED", {
      party_id, correlation_id, option_id,
      totals: [...totalsByCur.values()],
      open_items: openItems,
      balanced,
      entry_count: entries.length,
    }, { correlationId: correlation_id, summary: balanced ? "资金对账平衡" : `资金未平衡，${openItems.length} 个未决项` });

    return { balanced, totals: [...totalsByCur.values()], open_items: openItems, entries };
  }
}
