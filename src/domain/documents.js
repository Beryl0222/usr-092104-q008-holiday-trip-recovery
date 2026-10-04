/**
 * 证件与成员资格规则。
 *
 * 关键约束：证件期限只影响「受限成员」。
 * - 团队成员可以携带 documents（护照/通行证等），每份证件有 valid_until；
 * - 某段行程标记文档要求（如境外段要求护照自回程起仍有 6 个月有效期）时，
 *   只检查被标记为受该要求约束的成员；团队里证件充裕的成员不因此被一起拦下，
 *   规划器据此给出「拆分同行」而不是整团改签。
 */

/** 简单日历日差：b - a（按 UTC 日期分量，证件规则按自然日/月，不涉及时区分钟）。 */
export function calendarDaysBetween(a, b) {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((db - da) / 86_400_000);
}

/**
 * @param {string} validUntil 证件有效期止，YYYY-MM-DD
 * @param {string} requiredUntil 该段要求覆盖到的日期（一般是境外回程日期），YYYY-MM-DD
 * @param {number} minRemainingDays 要求的剩余有效期天数（6 个月按 180 天计，由调用方传入）
 */
export function documentSatisfies(validUntil, requiredUntil, minRemainingDays) {
  return calendarDaysBetween(requiredUntil, validUntil) >= minRemainingDays;
}

/**
 * 返回在该段上证件不满足的成员（只可能是 restrictedMemberIds 之内的人）。
 * @param {Array<{member_id:string, restrictedMemberIds?:string[], documents?:Array<{type:string,valid_until:string}>}>}
 */
export function membersBlockedOnDocuments(members, requirement) {
  const { documentType, requiredUntil, minRemainingDays, restrictedMemberIds } = requirement;
  const blocked = [];
  for (const id of restrictedMemberIds) {
    const member = members.find((m) => m.member_id === id);
    if (!member) {
      blocked.push({ member_id: id, reason: "成员不存在" });
      continue;
    }
    const doc = (member.documents ?? []).find((d) => d.type === documentType);
    if (!doc || !documentSatisfies(doc.valid_until, requiredUntil, minRemainingDays)) {
      blocked.push({
        member_id: id,
        reason: !doc ? `缺少证件：${documentType}` : `证件有效期不足：${documentType}`,
        valid_until: doc?.valid_until ?? null,
      });
    }
  }
  return blocked;
}
