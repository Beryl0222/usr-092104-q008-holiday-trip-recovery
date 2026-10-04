# 假期联程保障协商：领域词汇与不变量

本文档把"双节行程中断"的协商规则固化为各方共同遵守的词汇、事件顺序与资金语义。所有跨单位交换一律使用 `contracts/domain.schema.json` 定义的事件信封，单事件合法性由 `validateEvent` 校验，事件流顺序由 `validateSequence` 校验。

## 1. 核心对象

| 聚合 | 含义 | 关键身份 |
| --- | --- | --- |
| travel_party | 同行团体及其成员，成员可因证件或偏好在团体间移动 | party_id |
| booking_segment | 一段有依赖关系的行程：火车、国内航班、酒店、县城接驳、境外后半程 | segment_id |
| recovery_option | 一次中断下向旅客提出的协商方案（保留/改签/拆分同行/取消） | option_id |
| financial_resolution | 一次协商最终的资金核销单 | resolution_id |
| supplier_callback | 供应方回调的接收记录，是幂等判断的依据 | supplier + callback_id |
| notification_delivery | 一条面向旅客的通知及其送达回执 | notification_id |

行程是**有依赖关系的段序列**，但每一段始终保留供应方自己的状态机：`booked`（预订）→ `waitlisted`（候补）→ `ticketed`（出票）→ `rebooked`（改签）→ `refunded`（退款）。协商层只发指令、不替供应方记账；供应方状态只通过回调事件回流。

## 2. 事件目录

| 事件 | 聚合 | 语义 | payload 关键字段 |
| --- | --- | --- | --- |
| SEGMENT_CONFIRMED | booking_segment | 段在供应方侧落单 | party_id, segment_kind, supplier, supplier_order_id, supplier_status, timezone |
| DISRUPTION_RECEIVED | booking_segment | 收到延误或候补失败等中断信号 | cause, detected_at |
| OPTION_PROPOSED | recovery_option | 生成方案并算出给旅客看的三笔账 | party_id, disruption_event_id, option_kind, added_cost, forfeited_benefits, pending_suppliers |
| OPTION_FREEZED | recovery_option | 方案快照冻结，冻结期内价格与内容不变 | freeze_id, expires_at |
| PRICE_PROMISED | recovery_option | 登记对旅客的价格承诺（如改签差价上限） | promise_id, amount, currency |
| CHOICE_ACCEPTED | recovery_option | 旅客确认某个冻结方案 | freeze_id, accepted_by, preference_note |
| SEGMENT_HELD | booking_segment | 按确认结果保留原段，不做任何变更 | based_on_choice, supplier_order_id |
| SEGMENT_REBOOKED | booking_segment | 按确认结果改签 | based_on_choice, supplier_order_id |
| SEGMENT_CANCELLED | booking_segment | 按确认结果取消 | based_on_choice, supplier_order_id |
| PARTY_SPLIT | travel_party | 拆分同行，部分成员走不同方案 | new_party_id, moved_member_ids, reason |
| DOCUMENT_RESTRICTION_FLAGGED | travel_party | 登记某成员的证件期限限制 | member_id, valid_until, restricted_segment_ids |
| SUPPLIER_CALLBACK_APPLIED | supplier_callback | 供应方回调首次应用 | supplier, callback_id, segment_id, reported_status |
| SUPPLIER_CALLBACK_DUPLICATE | supplier_callback | 同一回调再次到达，仅留痕不执行 | supplier, callback_id, segment_id, reported_status |
| NOTIFICATION_DISPATCHED / DELIVERED / FAILED | notification_delivery | 通知发出 / 送达回执 / 送达失败 | party_id, channel, related_event_id |
| FUNDS_RECONCILED | financial_resolution | 资金核销，逐笔对应承诺与供应方 | party_id, lines[]（kind, amount, currency, promise_id, supplier） |

`OPTION_PROPOSED` 的三笔账是方案对旅客可见的最小信息集：**added_cost**（新增成本）、**forfeited_benefits**（损失权益）、**pending_suppliers**（仍待确认的供应方）。三者缺一，方案不得进入冻结。

## 3. 协商顺序与不变量

1. **冻结先于确认**：`CHOICE_ACCEPTED` 必须引用同一方案上已发生的 `OPTION_FREEZED` 的 `freeze_id`，且确认时间不得晚于 `expires_at`。冻结过期后只能重新出价、重新冻结。
2. **未确认不动有效订单**：`SEGMENT_HELD` / `SEGMENT_REBOOKED` / `SEGMENT_CANCELLED` 必须携带 `based_on_choice` 指向一个已发生的 `CHOICE_ACCEPTED`。旅客没点头之前，任何仍有效的订单不得被替换——这正是"先冻结给旅客看"的技术含义。
3. **版本逐条递增**：同一聚合（aggregate_type + aggregate_id）上的事件 version 必须逐条 +1，乱序或跳号即视为交换方违约。
4. **回调幂等**：同一 `supplier + callback_id` 只允许出现一次 `SUPPLIER_CALLBACK_APPLIED`；重复到达记为 `SUPPLIER_CALLBACK_DUPLICATE`，既不二次占位也不二次退款。标记为重复的回调必须能对应到一条首次应用记录。
5. **资金可溯**：`FUNDS_RECONCILED` 的每条明细若引用 `promise_id`，该承诺必须已由 `PRICE_PROMISED` 登记。争议人员沿 `PRICE_PROMISED → CHOICE_ACCEPTED → FUNDS_RECONCILED` 即可找到每笔资金的去向。

## 4. 证件与成员

证件期限通过 `DOCUMENT_RESTRICTION_FLAGGED` 挂在**成员**上，而不是整个团体。`restricted_segment_ids` 只列出受影响的段（通常是境外后半程）；其余成员、其余段不受约束。需要差异化安排时用 `PARTY_SPLIT` 把受限成员移入新团体，两个团体各自确认各自的方案——同行偏好以 `CHOICE_ACCEPTED.preference_note` 与 `PARTY_SPLIT.reason` 留痕，事后可解释"谁选择了什么、为什么分开走"。

## 5. 时间规则

- 所有事件的 `occurred_at` 必须带时区偏移（`+08:00` 或 `Z`），不允许裸本地时间。
- 段与段之间的连接（含跨时区、跨午夜）按**每段落地/出发地的当地时间**计算；段的 `timezone` 字段（IANA 名称）是该段的解释基准。判断"赶不赶得上"时，先各自换算到本地日历日再比较，禁止用单一 UTC 日期截断。
- 冻结到期 `expires_at` 与确认时间的比较用绝对时间轴（带偏移解析后比较）。

## 6. 可追溯性清单

| 关切 | 追溯路径 |
| --- | --- |
| 旅客选择了什么 | `OPTION_FREEZED`（看到的快照）→ `CHOICE_ACCEPTED`（谁、何时、偏好备注） |
| 客服哪里还悬着 | 方案的 `pending_suppliers` 与尚未到达的 `SUPPLIER_CALLBACK_APPLIED` |
| 通知是否真正送达 | `NOTIFICATION_DISPATCHED → DELIVERED / FAILED`，`related_event_id` 指回被通知的事件 |
| 价格承诺是否兑现 | `PRICE_PROMISED` 的 `promise_id` 对照 `FUNDS_RECONCILED` 明细行 |
| 回调有没有被重复执行 | `supplier + callback_id` 上 APPLIED 与 DUPLICATE 的配对 |
