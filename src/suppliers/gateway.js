/**
 * 供应方网关（模拟侧）。
 *
 * 它代表 12306/航司/酒店/接驳等供应方自己的预订、候补、出票、改签、退款系统。
 * 每一段保留供应方侧状态；保障域通过此网关操作，绝不直接改供应方订单。
 *
 * 幂等防线（两道，缺一不可）：
 * - 出站请求：按 (supplier, operation, idempotencyKey) 记忆结果，重复调用原样返回，
 *   因此重试不会二次占位、二次退款；
 * - 入站回调：按 callback_id 记忆，重复回调只回传首次结论、不产生任何副作用。
 *
 * 价格承诺：quote 在有效期内锁价；出票时供应方即使改价，也按承诺价结算，
 * 差额由调用方通过 SUPPLIER_PRICE_CHANGED 留痕，旅客看到的价格不被偷换。
 */

export class SupplierError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "SupplierError";
    this.code = code;
    this.details = details;
  }
}

const clone = (x) => structuredClone(x);

export class SupplierGateway {
  #bookings = new Map(); // supplier_ref
  #holds = new Map(); // hold_id
  #refunds = new Map(); // refund_id
  #commitments = new Map(); // commitment_id
  #callbacks = new Map(); // callback_id -> 首次处理结果
  #idem = new Map(); // `${supplier}:${operation}:${key}` -> 首次结果
  #seq = 0;

  constructor({ now = () => new Date(), failure = null } = {}) {
    this.#tick = now;
    this.failure = failure; // ({supplier, operation}) => Error | null，测试用故障注入
  }

  #tick;

  #id(service) {
    this.#seq += 1;
    return `${service}-${String(this.#seq).padStart(4, "0")}`;
  }

  #idempotent(supplier, operation, key, fn) {
    if (!key) throw new SupplierError("IDEMPOTENCY_KEY_REQUIRED", `${supplier}.${operation} 必须带幂等键`);
    const mapKey = `${supplier}:${operation}:${key}`;
    if (this.#idem.has(mapKey)) {
      return { ...this.#idem.get(mapKey), replayed: true };
    }
    const injected = this.failure?.({ supplier, operation, key });
    if (injected) throw injected instanceof Error ? injected : new SupplierError("SUPPLIER_FAILURE", String(injected));
    const result = fn();
    this.#idem.set(mapKey, result);
    return { ...result, replayed: false };
  }

  // ---------- 供应方侧既有订单注册（模拟供应方系统里已有这张单） ----------
  registerBooking({ supplier_ref, supplier, kind, amount, currency, status = "booked", passengers, raw }) {
    this.#bookings.set(supplier_ref, {
      supplier_ref,
      supplier,
      kind,
      amount,
      currency,
      status,
      passengers: passengers ?? [],
      history: [{ at: this.#tick().toISOString(), to: status }],
      raw,
    });
    return clone(this.#bookings.get(supplier_ref));
  }

  getBooking(supplierRef) {
    const b = this.#bookings.get(supplierRef);
    return b ? clone(b) : null;
  }

  // ---------- 候补结果由供应方回调给出 ----------
  setWaitlistOutcome(supplierRef, outcome) {
    const b = this.#bookings.get(supplierRef);
    if (!b) throw new SupplierError("UNKNOWN_BOOKING", `供应方订单不存在：${supplierRef}`);
    b.status = outcome === "confirmed" ? "booked" : "failed";
    b.history.push({ at: this.#tick().toISOString(), to: b.status });
    return clone(b);
  }

  // ---------- 价格承诺 ----------
  quotePrice({ supplier, amount, currency, ttlMs, idempotencyKey, meta = {} }) {
    return this.#idempotent(supplier, "quote", idempotencyKey, () => {
      const commitment_id = this.#id("qte");
      const now = this.#tick();
      const commitment = {
        commitment_id,
        supplier,
        amount,
        currency,
        valid_from: now.toISOString(),
        valid_until: new Date(now.getTime() + ttlMs).toISOString(),
        meta,
      };
      this.#commitments.set(commitment_id, clone(commitment));
      return clone(commitment);
    });
  }

  /** 测试用：让供应方在出票时改价（不覆盖承诺，只记录其「现价」）。 */
  setCurrentPrice(supplier, amount) {
    this.#currentPrices ??= new Map();
    this.#currentPrices.set(supplier, amount);
  }
  #currentPrices = new Map();

  // ---------- 占位（冻结阶段；绝不触碰仍有效订单） ----------
  placeHold(args) {
    const { supplier, kind, passengers, amount, currency, ttlMs, idempotencyKey, commitment_id, segment_id } = args;
    return this.#idempotent(supplier, "hold", idempotencyKey, () => {
      let settledAmount = amount;
      let priceChanged = null;
      if (commitment_id) {
        const c = this.#commitments.get(commitment_id);
        if (!c) throw new SupplierError("UNKNOWN_COMMITMENT", `价格承诺不存在：${commitment_id}`);
        if (this.#tick().getTime() > new Date(c.valid_until).getTime()) {
          throw new SupplierError("COMMITMENT_EXPIRED", `价格承诺已过期：${commitment_id}`);
        }
        const current = this.#currentPrices.get(supplier);
        if (current != null && current !== c.amount) {
          priceChanged = { from: current, to: c.amount };
          // 承诺锁价：占位按承诺金额
        }
        settledAmount = c.amount;
      }
      const hold_id = this.#id("hld");
      const now = this.#tick();
      const hold = {
        hold_id,
        supplier,
        kind,
        segment_id: segment_id ?? null,
        passengers: [...passengers],
        amount: settledAmount,
        currency,
        commitment_id: commitment_id ?? null,
        status: "held",
        placed_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ttlMs).toISOString(),
        price_changed: priceChanged,
      };
      this.#holds.set(hold_id, hold);
      return clone({ hold, price_changed: priceChanged });
    });
  }

  getHold(holdId) {
    const h = this.#holds.get(holdId);
    return h ? clone(h) : null;
  }

  /** 占位出票：只在占位上发生，绝不从有效订单直接扣款。 */
  ticketHold({ hold_id, idempotencyKey }) {
    const h = this.#holds.get(hold_id);
    if (!h) throw new SupplierError("UNKNOWN_HOLD", `占位不存在：${hold_id}`);
    return this.#idempotent(h.supplier, "ticket", idempotencyKey, () => {
      if (this.#tick().getTime() > new Date(h.expires_at).getTime()) {
        h.status = "expired";
        throw new SupplierError("HOLD_EXPIRED", `占位已过期：${hold_id}`);
      }
      if (h.status !== "held") {
        throw new SupplierError("HOLD_NOT_TICKETABLE", `占位状态为 ${h.status}，不能出票`);
      }
      h.status = "ticketed";
      const supplier_ref = this.#id("pnr");
      const booking = {
        supplier_ref,
        supplier: h.supplier,
        kind: h.kind,
        amount: h.amount,
        currency: h.currency,
        status: "booked",
        passengers: [...h.passengers],
        hold_id,
        commitment_id: h.commitment_id,
        history: [{ at: this.#tick().toISOString(), to: "booked" }],
      };
      this.#bookings.set(supplier_ref, booking);
      h.supplier_ref = supplier_ref;
      return clone({ supplier_ref, hold: h });
    });
  }

  releaseHold({ hold_id, reason = "released", idempotencyKey }) {
    const h = this.#holds.get(hold_id);
    if (!h) throw new SupplierError("UNKNOWN_HOLD", `占位不存在：${hold_id}`);
    return this.#idempotent(h.supplier, "release", idempotencyKey, () => {
      if (h.status === "held") h.status = reason === "ticketed" ? "ticketed" : "released";
      return clone({ hold_id: h.hold_id, status: h.status, reason });
    });
  }

  // ---------- 取消与退款（只能作用于仍有效订单，且一次申请只退一次） ----------
  requestRefund({ supplier_ref, amount, currency, reason, idempotencyKey, partial = false }) {
    const b = this.#bookings.get(supplier_ref);
    if (!b) throw new SupplierError("UNKNOWN_BOOKING", `供应方订单不存在：${supplier_ref}`);
    return this.#idempotent(b.supplier, "refund", idempotencyKey, () => {
      const existingFull = [...this.#refunds.values()].find(
        (r) => r.supplier_ref === supplier_ref && r.state === "confirmed" && !r.partial
      );
      if (existingFull) {
        throw new SupplierError("ALREADY_REFUNDED", `该订单已全额退款：${existingFull.refund_id}`, {
          refund_id: existingFull.refund_id,
        });
      }
      if (b.status === "refunded") {
        throw new SupplierError("ALREADY_REFUNDED", `该订单已处于退款终态`, { supplier_ref });
      }
      if (!["booked", "ticketed"].includes(b.status)) {
        throw new SupplierError("NOT_REFUNDABLE", `订单状态 ${b.status} 不可退款`);
      }
      const want = amount ?? b.amount;
      const refundedBefore = [...this.#refunds.values()]
        .filter((r) => r.supplier_ref === supplier_ref && r.state === "confirmed")
        .reduce((sum, r) => sum + r.amount, 0);
      if (Math.round((refundedBefore + want) * 100) > Math.round(b.amount * 100)) {
        throw new SupplierError("REFUND_EXCEEDS_PAID",
          `累计退款 ${refundedBefore + want} 超过订单金额 ${b.amount}（已退 ${refundedBefore}）`,
          { refunded_before: refundedBefore, paid: b.amount });
      }
      const refund_id = this.#id("ref");
      const refund = {
        refund_id,
        supplier_ref,
        supplier: b.supplier,
        amount: amount ?? b.amount,
        currency: currency ?? b.currency,
        reason: reason ?? null,
        partial,
        state: "confirmed", // 模拟供应方同步确认；异步供应方可拆 requested/confirmed
        at: this.#tick().toISOString(),
      };
      this.#refunds.set(refund_id, refund);
      if (!partial) {
        b.status = "refunded";
      }
      b.history.push({ at: this.#tick().toISOString(), to: partial ? `partial_refund:${refund_id}` : "refunded" });
      return clone(refund);
    });
  }

  // ---------- 入站回调：callback_id 去重 ----------
  /**
   * @param {{callback_id:string, supplier:string, type:string, supplier_ref?:string, outcome?:string, raw?:object}} cb
   * @param {(cb)=>any} handler 仅在首次见到 callback_id 时执行，异常不记忆（允许供应方重投后修正）
   */
  ingestCallback(cb, handler) {
    if (!cb?.callback_id) throw new SupplierError("CALLBACK_ID_REQUIRED", "回调缺少 callback_id");
    if (this.#callbacks.has(cb.callback_id)) {
      return { ...this.#callbacks.get(cb.callback_id), duplicate: true };
    }
    const result = handler(cb);
    this.#callbacks.set(cb.callback_id, clone(result));
    return { ...clone(result), duplicate: false };
  }

  hasCallback(callbackId) {
    return this.#callbacks.has(callbackId);
  }
}
