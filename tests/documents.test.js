import assert from "node:assert/strict";
import test from "node:test";

import { documentSatisfies, membersBlockedOnDocuments } from "../src/domain/documents.js";

const members = [
  { member_id: "p1", documents: [{ type: "passport", valid_until: "2030-06-01" }] },
  { member_id: "p3", documents: [{ type: "passport", valid_until: "2026-11-01" }] },
  { member_id: "p4", documents: [{ type: "passport", valid_until: "2031-01-01" }] },
];

const requirement = {
  documentType: "passport",
  requiredUntil: "2026-10-08",
  minRemainingDays: 180,
  restrictedMemberIds: ["p1", "p3", "p4"],
};

test("护照六个月规则只判定到受限成员个人", () => {
  assert.equal(documentSatisfies("2030-06-01", "2026-10-08", 180), true);
  // p3 护照 2026-11-01 到期，距回程仅 24 天，不足 180
  assert.equal(documentSatisfies("2026-11-01", "2026-10-08", 180), false);
});

test("受限名单之外的成员（如老人不标记境外要求）不受影响", () => {
  const blocked = membersBlockedOnDocuments(members, requirement).map((b) => b.member_id);
  assert.deepEqual(blocked, ["p3"]);
  const blockedSubset = membersBlockedOnDocuments(members, {
    ...requirement,
    restrictedMemberIds: ["p1", "p4"],
  });
  assert.deepEqual(blockedSubset, []);
});
