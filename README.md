# 假期联程保障协商

本仓库保存假期联程保障协商的领域词汇、事件约定与基础校验代码，供相关单位统一对象身份、事件顺序和版本语义。

## 目录

- `contracts/domain.schema.json`：领域事件信封、稳定枚举与各事件的 payload 契约。
- `docs/glossary.md`：核心对象、事件目录、协商顺序与不变量、证件与时间规则、可追溯性清单。
- `data/sample.json`：一条中文联调样例。
- `data/sample-flow.json`：一次完整协商的事件流样例（延误 → 出价 → 冻结 → 承诺 → 通知 → 确认 → 拆分/改签/保留 → 回调幂等 → 核销）。
- `src/`：事件基础字段校验（`validateEvent`）与事件流顺序不变量校验（`validateSequence`）。
- `tests/`：领域资料一致性检查。

当前核心对象为 travel_party、booking_segment、recovery_option、financial_resolution、supplier_callback、notification_delivery。已登记事件为 SEGMENT_CONFIRMED、DISRUPTION_RECEIVED、OPTION_PROPOSED、OPTION_FREEZED、PRICE_PROMISED、CHOICE_ACCEPTED、SEGMENT_HELD、SEGMENT_REBOOKED、SEGMENT_CANCELLED、PARTY_SPLIT、DOCUMENT_RESTRICTION_FLAGGED、SUPPLIER_CALLBACK_APPLIED、SUPPLIER_CALLBACK_DUPLICATE、NOTIFICATION_DISPATCHED、NOTIFICATION_DELIVERED、NOTIFICATION_FAILED、FUNDS_RECONCILED。这些资料描述基础交换边界，后续服务应保持事件兼容性：新增事件类型与聚合类型只允许追加，不得修改既有枚举语义。

## 本地检查

```bash
npm test
```
