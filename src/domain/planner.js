/**
 * 联程恢复规划器（纯函数，不做 I/O）。
 *
 * 输入：团队、各段当前状态（含供应方侧自己的状态）、中断事实、可售备选、退改规则。
 * 输出：受影响清单 + 若干恢复方案；每个动作显式给出
 *   - added_cost：新增成本
 *   - lost_entitlement：损失权益（不可退金额/失效候补权/差价等）
 *   - refund：预计可退
 *   - pending_supplier：仍需供应方确认
 *   - 方案整体标注哪些「仍有效订单」在确认前一律不动。
 *
 * 关键判断：
 * - 依赖图上中断向下游传播，但能否继续使用按当地时间规则逐段判断，
 *   跨午夜红眼到达在酒店夜切截止前仍保住当晚住房（不新增一晚）；
 * - 晚点（delay）的车票本身仍有效，旅客仍在车上，只有候补失败/取消才需要替换该段；
 * - 证件期限只让受限成员上不了受限段，方案是「拆分同行」而非整团改签，与衔接无关；
 * - 「逐单退款」方案被如实算出更大的损失权益，作为对照而非默认；
 * - 候补未出票的段没有已付权益，不产生退款、也不算旅客损失（只释放候补占位）。
 */

import { asInstant, belongsToPreviousServiceNight, gapMinutes, localDate, meetsMinimumConnection } from "./time.js";
import { membersBlockedOnDocuments } from "./documents.js";

export const DEFAULT_MCT_MINUTES = {
  "railway:domestic_air": 120,
  "railway:county_shuttle": 60,
  "domestic_air:domestic_air": 90,
  "domestic_air:overseas_air": 150,
  "domestic_air:county_shuttle": 60,
  "county_shuttle:hotel": 30,
  "county_shuttle:overseas_hotel": 45,
  "domestic_air:hotel": 90,
  "overseas_air:overseas_hotel": 90,
  "overseas_air:hotel": 90,
};

const HOTEL_KINDS = new Set(["hotel", "overseas_hotel"]);

const addMoney = (acc, m) => {
  if (!m) return acc;
  const cur = acc.find((x) => x.currency === m.currency);
  if (cur) cur.amount = Math.round((cur.amount + m.amount) * 100) / 100;
  else acc.push({ amount: m.amount, currency: m.currency });
  return acc;
};
const sumMoney = (list) => (list ?? []).reduce((acc, m) => addMoney(acc, m), []);

function edgeMct(a, b, overrides) {
  const key = `${a.kind}:${b.kind}`;
  return overrides?.[`${a.segment_id}->${b.segment_id}`] ?? overrides?.[key] ?? DEFAULT_MCT_MINUTES[key] ?? 60;
}

/**
 * 判断在前段实际到达 arrivalAt 的情况下，下游段 downstream 是否仍可使用。
 */
export function canStillUse(upstream, downstream, arrivalAt, disruptionBySegment, mctOverrides) {
  if (!arrivalAt || !downstream.dep?.at) {
    return { usable: true, reason: "缺少时刻，按可用处理" };
  }
  if (disruptionBySegment.get(downstream.segment_id)) {
    return { usable: false, reason: "下游自身中断" };
  }
  if (HOTEL_KINDS.has(downstream.kind) && downstream.service_date) {
    const tz = downstream.tz ?? downstream.dep?.tz ?? upstream.arr?.tz ?? upstream.dep?.tz;
    const cutoff = downstream.night_cutoff_minutes ?? 4 * 60;
    if (belongsToPreviousServiceNight(arrivalAt, tz, downstream.service_date, cutoff)) {
      const hh = String(Math.floor(cutoff / 60)).padStart(2, "0");
      const mm = String(cutoff % 60).padStart(2, "0");
      return { usable: true, reason: `跨午夜到达，仍在 ${hh}:${mm} 夜切前，保留 ${downstream.service_date} 当晚住房` };
    }
    const arrDate = localDate(arrivalAt, tz);
    if (arrDate === downstream.service_date) {
      return { usable: true, reason: "当地入住日到达，住房保留" };
    }
    return { usable: false, reason: `到达当地日期 ${arrDate} 已超出酒店入住夜 ${downstream.service_date}` };
  }
  const depAt = asInstant(downstream.dep.at);
  const mct = edgeMct(upstream, downstream, mctOverrides);
  const gap = gapMinutes(arrivalAt, depAt);
  if (meetsMinimumConnection(arrivalAt, depAt, mct)) {
    return { usable: true, reason: `衔接 ${gap} 分钟 ≥ MCT ${mct}` };
  }
  return { usable: false, reason: `衔接仅 ${gap} 分钟 < MCT ${mct}` };
}

/** 证件受限成员对某段的拆分判断 */
function documentSplit(segment, members) {
  if (!segment.document_requirement) return { blocked: [], eligible: segment.passenger_ids ?? [] };
  const req = segment.document_requirement;
  const restricted = req.restricted_member_ids ?? segment.passenger_ids ?? [];
  const blocked = membersBlockedOnDocuments(members, { ...req, restrictedMemberIds: restricted }).map((b) => b.member_id);
  const eligible = (segment.passenger_ids ?? []).filter((id) => !blocked.includes(id));
  return { blocked, eligible };
}

/**
 * @param {object} input
 */
export function planRecovery({ party, segments, disruption, alternatives = [], refundPolicies = {}, mctOverrides = null }) {
  const byId = new Map(segments.map((s) => [s.segment_id, s]));
  const disruptionBySegment = new Map([[disruption.segment_id, disruption]]);

  // 1) 依赖传播
  const impacted = new Map();
  const root = byId.get(disruption.segment_id);
  if (!root) throw new Error(`中断段不存在：${disruption.segment_id}`);
  // 晚点车票仍有效（旅客仍在车上）；候补失败/取消才需要替换该段本身
  const rootUsable = disruption.kind === "delay";
  impacted.set(root.segment_id, {
    segment_id: root.segment_id,
    self: true,
    usable: rootUsable,
    reason:
      disruption.kind === "waitlist_failed" ? "候补失败，原单不可用"
      : disruption.kind === "cancellation" ? "供应方取消，原单不可用"
      : "车次晚点但车票仍有效，按新到达时刻评估联程",
  });

  // 不可用段的最便宜备选（下游按备选到达时刻判断是否仍能保住）
  const altBySegment = new Map();
  for (const seg of segments) {
    const alt = alternatives
      .filter((a) => a.replaces_segment_id === seg.segment_id)
      .sort((a, b) => a.price.amount - b.price.amount)[0];
    if (alt) altBySegment.set(seg.segment_id, alt);
  }

  const arrivalFor = (seg) => {
    const d = disruptionBySegment.get(seg.segment_id);
    if (d?.new_arr) return asInstant(d.new_arr);
    const impact = impacted.get(seg.segment_id);
    if (impact && !impact.usable) {
      const alt = altBySegment.get(seg.segment_id);
      return alt?.arr?.at ? asInstant(alt.arr.at) : null;
    }
    return seg.arr?.at ? asInstant(seg.arr.at) : null;
  };

  const queue = [root];
  const seen = new Set([root.segment_id]);
  while (queue.length) {
    const up = queue.shift();
    const upImpact = impacted.get(up.segment_id);
    for (const dep of segments) {
      if (seen.has(dep.segment_id)) continue;
      if (!(dep.depends_on ?? []).includes(up.segment_id)) continue;
      seen.add(dep.segment_id);
      if (!upImpact.usable && !altBySegment.has(up.segment_id)) {
        impacted.set(dep.segment_id, {
          segment_id: dep.segment_id,
          self: false,
          usable: false,
          reason: `上游 ${up.segment_id} 不可用且暂无备选，能否衔接待供应方确认`,
        });
      } else {
        const arrival = arrivalFor(up);
        const judgment = arrival
          ? canStillUse(up, dep, arrival, disruptionBySegment, mctOverrides)
          : { usable: false, reason: "上游到达时刻未知，待确认" };
        impacted.set(dep.segment_id, { segment_id: dep.segment_id, self: false, ...judgment });
      }
      queue.push(dep);
    }
  }

  // 2) 证件受限成员（只影响受限段，与衔接是否来得及无关）
  const splits = [];
  for (const seg of segments) {
    if (!seg.document_requirement) continue;
    const { blocked, eligible } = documentSplit(seg, party.members);
    if (blocked.length > 0) splits.push({ segment_id: seg.segment_id, blocked, eligible });
  }

  const pickAlternative = (segmentId, passengerIds) =>
    alternatives
      .filter((a) => a.replaces_segment_id === segmentId)
      .filter((a) => (a.covers ? passengerIds.every((id) => a.covers.includes(id)) : true))
      .filter((a) => (a.seats ?? Infinity) >= passengerIds.length || a.covers)
      .sort((a, b) => a.price.amount - b.price.amount)[0] ?? null;

  const refundOf = (seg) =>
    refundPolicies[seg.segment_id] ?? {
      refundable: seg.price ? { amount: 0, currency: seg.price.currency } : null,
      penalty: "无退款规则登记，按不可退预估",
      note: "待供应方确认",
      pending_supplier: seg.supplier,
    };

  /** 候补未出票/已失败的段没有已付权益，不产生退款也不算损失 */
  const isPaid = (seg) => seg.status === "booked" || seg.status === "ticketed";
  const share = (moneyAmount, seg, memberIds) => {
    if (!isPaid(seg) || !moneyAmount) return null;
    const total = seg.passenger_ids?.length || memberIds.length || 1;
    return { amount: Math.round((moneyAmount.amount / total) * memberIds.length * 100) / 100, currency: moneyAmount.currency };
  };
  const paidShare = (seg, memberIds) => share(seg.price, seg, memberIds);
  const refundShare = (seg, policy, memberIds) => share(policy.refundable, seg, memberIds);
  const lossAfter = (paid, refund) =>
    paid && refund ? { amount: Math.round((paid.amount - refund.amount) * 100) / 100, currency: paid.currency } : paid;

  // ---------- 方案 A：保住仍可使用的一切，只替换真正不可用的段；证件受限则拆分 ----------
  const actionsA = [];
  const pendingA = new Set();
  const untouchedA = [];
  const addPending = (action) => { if (action.pending_supplier) pendingA.add(action.pending_supplier); };

  for (const seg of segments) {
    const impact = impacted.get(seg.segment_id);
    const split = splits.find((x) => x.segment_id === seg.segment_id);

    // 1) 证件受限先拆
    if (split) {
      const { blocked, eligible } = split;
      const alt = eligible.length ? pickAlternative(seg.segment_id, eligible) : null;
      const policy = refundOf(seg);
      const paidBlocked = paidShare(seg, blocked);
      const refundBlocked = refundShare(seg, policy, blocked);
      // 有备选：合格成员改走新票，旧 PNR 整体换开退回（受限名额+合格成员旧票）；
      // 无备选：只退受限成员名额，合格成员旧票保留待人工跟进
      const refund = alt ? (isPaid(seg) ? policy.refundable : null) : refundBlocked;
      const lost = alt
        ? (isPaid(seg) ? lossAfter(seg.price, policy.refundable) : null)
        : lossAfter(paidBlocked, refundBlocked);
      const action = {
        segment_id: seg.segment_id,
        action: "split",
        supplier: seg.supplier,
        detail: `证件受限成员 ${blocked.join("、")} 拆出；合格成员 ${eligible.join("、") || "无"} 另行安排`,
        keep_passenger_ids: eligible,
        split_passenger_ids: blocked,
        alternative: alt ? { alternative_id: alt.alternative_id, supplier: alt.supplier, price: alt.price, dep: alt.dep, arr: alt.arr } : null,
        added_cost: alt ? alt.price : null,
        lost_entitlement: lost,
        refund,
        pending_supplier: alt?.supplier ?? seg.supplier,
      };
      actionsA.push(action);
      addPending(action);
      continue;
    }

    // 2) 不受影响 / 评估后仍可使用：原单保留
    if (!impact || impact.usable) {
      actionsA.push({
        segment_id: seg.segment_id,
        action: "preserve",
        supplier: seg.supplier,
        detail: impact?.reason ?? "未受中断影响，原单继续有效",
        added_cost: null,
        lost_entitlement: null,
        refund: null,
        passenger_ids: seg.passenger_ids,
      });
      if (isPaid(seg)) untouchedA.push(seg.segment_id);
      continue;
    }

    // 3) 真正不可用段：改签优先，无备选才取消
    const alt = pickAlternative(seg.segment_id, seg.passenger_ids ?? []);
    const policy = refundOf(seg);
    if (alt) {
      const action = {
        segment_id: seg.segment_id,
        action: "rebook",
        supplier: seg.supplier,
        detail: `改签为 ${alt.supplier} 备选 ${alt.alternative_id}`,
        alternative: { alternative_id: alt.alternative_id, supplier: alt.supplier, price: alt.price, dep: alt.dep, arr: alt.arr },
        added_cost: alt.price,
        lost_entitlement: isPaid(seg) ? lossAfter(seg.price, policy.refundable) : null,
        refund: isPaid(seg) ? policy.refundable : null,
        pending_supplier: alt.supplier,
      };
      actionsA.push(action);
      addPending(action);
    } else {
      const action = {
        segment_id: seg.segment_id,
        action: "cancel",
        supplier: seg.supplier,
        detail: "无可售备选，取消并按规则退款",
        added_cost: null,
        lost_entitlement: isPaid(seg) ? lossAfter(seg.price, policy.refundable) : null,
        refund: isPaid(seg) ? policy.refundable : null,
        pending_supplier: seg.supplier,
      };
      actionsA.push(action);
      addPending(action);
    }
  }

  // ---------- 方案 B：受影响链逐单取消退款（对照方案：损失更大） ----------
  const actionsB = [];
  const pendingB = new Set();
  for (const seg of segments) {
    const impact = impacted.get(seg.segment_id);
    if (!impact) {
      actionsB.push({ segment_id: seg.segment_id, action: "preserve", detail: "不在中断链上", supplier: seg.supplier, refund: null, added_cost: null, lost_entitlement: null });
      continue;
    }
    const policy = refundOf(seg);
    const action = {
      segment_id: seg.segment_id,
      action: "cancel",
      supplier: seg.supplier,
      detail: `逐单退款（即使该段${impact.usable ? "仍可使用" : "不可用"}）`,
      added_cost: null,
      lost_entitlement: isPaid(seg) ? lossAfter(seg.price, policy.refundable) : null,
      refund: isPaid(seg) ? policy.refundable : null,
      pending_supplier: seg.supplier,
    };
    actionsB.push(action);
    pendingB.add(seg.supplier);
  }

  const moneyOfActions = (actions, key) => sumMoney(actions.map((a) => a[key]).filter(Boolean));
  const totalsOf = (actions) => ({
    added_cost: moneyOfActions(actions, "added_cost"),
    lost_entitlement: moneyOfActions(actions, "lost_entitlement"),
    expected_refund: moneyOfActions(actions, "refund"),
  });

  return {
    disruption,
    impacts: [...impacted.values()],
    document_splits: splits,
    options: [
      {
        key: "preserve_rebook_split",
        title: "保住可用联程：保留 + 改签 + 必要时拆分",
        recommended: true,
        rationale: "未确认前不触碰任何仍有效订单；仅替换真正不可用段，证件问题只拆受限成员。",
        actions: actionsA,
        totals: totalsOf(actionsA),
        pending_suppliers: [...pendingA],
        untouched_valid_orders: untouchedA,
      },
      {
        key: "cancel_chain",
        title: "受影响链逐单取消退款",
        recommended: false,
        rationale: "操作最简单，但把仍可使用的航班、酒店和境外后半程一并退掉，损失权益最大。",
        actions: actionsB,
        totals: totalsOf(actionsB),
        pending_suppliers: [...pendingB],
        untouched_valid_orders: [],
      },
    ],
  };
}
