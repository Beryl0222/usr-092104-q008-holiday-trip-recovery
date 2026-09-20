# 假期联程保障协商

本仓库保存假期联程保障协商的领域词汇、事件约定与基础校验代码，供相关单位统一对象身份、事件顺序和版本语义。

## 目录

- `contracts/domain.schema.json`：领域事件信封与稳定枚举。
- `data/sample.json`：一条中文联调样例。
- `src/`：事件基础字段校验。
- `tests/`：领域资料一致性检查。

当前核心对象为travel_party、booking_segment、recovery_option、financial_resolution，已登记事件为SEGMENT_CONFIRMED、DISRUPTION_RECEIVED、OPTION_PROPOSED、CHOICE_ACCEPTED、FUNDS_RECONCILED。这些资料描述基础交换边界，后续服务应保持事件兼容性。

## 本地检查

```bash
npm test
```
