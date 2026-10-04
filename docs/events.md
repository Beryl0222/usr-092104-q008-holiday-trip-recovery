# 领域事件目录

所有事件共用信封（见 `contracts/domain.schema.json`）：

| 字段 | 说明 |
| --- | --- |
| `event_id` | 全局唯一；重复 id 必被事件存储拒绝 |
| `event_type` | 下表枚举，只追加、不复用、不改语义 |
| `aggregate_type` / `aggregate_id` | 事件所属聚合流 |
| `version` | 流内从 1 连续递增（乐观锁） |
| `occurred_at` | 真实发生时刻（带偏移或 Z） |
| `summary` | 中文人读摘要 |
| `causation_id` / `correlation_id` / `idempotency_key` | 因果、协商贯穿标识、幂等键 |
| `payload` | 事件负载 |

## 既有事件（v0.1，顺序与语义永不改动）

- `SEGMENT_CONFIRMED`：行程段确认/归属登记。段流上表示已出票订单；团队流上的副本用于维护团队→段索引。
- `DISRUPTION_RECEIVED`：收到供应方中断（延误/取消/候补失败）。
- `OPTION_PROPOSED`：提出恢复方案（含推荐方案与逐单退款对照）。
- `CHOICE_ACCEPTED`：旅客确认选择，冻结快照随事件存档。
- `FUNDS_RECONCILED`：对账结论（分币种净额、未决项）。

## v0.2 追加事件

**行程与团队**
- `PARTY_REGISTERED`：登记团队（成员证件、同行偏好、通知地址）。
- `SEGMENT_BOOKED`：供应方侧订单建档（含依赖、时刻时区、价格、酒店入住日夜切）。
- `SEGMENT_PRESERVED`：确认保留仍有效段，附保留理由。
- `SEGMENT_SPLIT`：拆分同行（合格成员与证件受限成员分流）。
- `SEGMENT_REBOOKED`：旧单被已出票的新单替换（先新后旧）。
- `SEGMENT_CANCELLED`：取消无备选且不可用的段。

**供应方交互**
- `WAITLIST_RESULT_RECEIVED`：候补结果回调（confirmed/failed）。
- `PRICE_COMMITMENT_RECORDED`：价格承诺原文（金额、有效期）。
- `OPTION_FROZEN`：方案冻结快照（动作、占位、合计、待确认供应方、到期时刻、人读摘要）。
- `OPTION_EXPIRED` / `OPTION_REJECTED`：冻结到期 / 旅客拒绝（均先释放占位）。
- `SUPPLIER_HOLD_PLACED` / `SUPPLIER_HOLD_RELEASED`：新资源占位及其释放/转出票。
- `SUPPLIER_TICKETED`：占位出票、供应方扣款（带供应方单号与承诺 id）。
- `SUPPLIER_PRICE_CHANGED`：供应方现价与承诺价不一致，仍按承诺价结算的留痕。
- `REFUND_REQUESTED` / `REFUND_CONFIRMED`：旧单退款申请与到账（带退款 id 与供应方单号）。
- `CALLBACK_REJECTED`：无法处理的入站回调（缺单号/未知类型），绝不假装成功。

**通知与资金**
- `NOTIFICATION_ATTEMPTED` / `NOTIFICATION_DELIVERED` / `NOTIFICATION_FAILED`：通知尝试、真实送达回执、失败原因。
- `PAYMENT_COLLECTED`：向旅客收取的净补款（新增成本减已退旧单）。

## 资金事件如何对账

`financial_resolution` 与争议视图直接扫描全库：

- `REFUND_CONFIRMED`、`PAYMENT_COLLECTED` 记为旅客侧流入；
- `SUPPLIER_TICKETED` 记为旅客侧流出（可经 `commitment_id` 回溯 `PRICE_COMMITMENT_RECORDED` 原文）；
- 占位（`SUPPLIER_HOLD_*`）不是资金移动；
- 每条资金记录都带 `supplier_ref`（供应方单号）与 `event_id`，平衡口径为分币种净额为 0。
