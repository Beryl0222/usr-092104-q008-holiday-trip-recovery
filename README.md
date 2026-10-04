# 假期联程保障协商后端

双节出行中断时，旅客常常为了保住第一段车票，反而错过后续仍可使用的航班、酒店与境外安排；客服逐单退款看似简单，却把可用订单一起退掉、扩大损失。

本服务把**火车、国内航班、酒店、县城接驳、境外后半程**视为一张有依赖关系的行程图，同时每一段保留供应方自己的预订/候补/出票/改签/退款状态。收到延误或候补失败后，系统先算出「保住可用联程」的方案——保留、改签、拆分同行、取消——把**新增成本、损失权益、待确认供应方、占位到期时刻**冻结给旅客看；**未经旅客确认，绝不替换任何仍有效订单**。

## 核心规则

1. **未确认不替换，确认后先立后破**
   - 冻结（freeze）只向供应方申请占位与价格承诺，供应方侧原订单状态原封不动；
   - 旅客确认后，先把所有占位出成新票、新单建档，再取消/退旧单。任一步失败都不会出现「旧单已退、新单没有」。
2. **逐单退款只是对照方案**：规划器始终同时给出「保联程」与「逐单取消」两个方案及损失对比，默认推荐损失更小的前者。
3. **当地时间规则**（`src/domain/time.js`）
   - 衔接按 IANA 时区下的绝对分钟差计算（跨时区、跨夏令时不会时钟倒走）；
   - 跨午夜红眼到达（如次日 00:35 落地）在酒店 04:00 夜切前，仍保住入住日当晚住房，不新增一晚；
   - 事件里持久化的 `local` 只是 `at + tz` 的投影，禁止用两个 local 字符串直接相减。
4. **证件期限只影响受限成员**（`src/domain/documents.js`）：护照六个月要求只检查该段 `restricted_member_ids` 中的成员；孩子证件不足时方案是「拆分同行」（合格成员走新票、受限成员名额退回），不整团改签。
5. **幂等三道防线**
   - 入站回调按 `callback_id` 去重，重复回调只回传首次结论、不产生副作用；
   - 领域事件按 `event_id` 全局唯一、流内 `version` 乐观锁（重复事件直接拒绝）；
   - 出站供应方请求（报价/占位/出票/退款）带确定性幂等键；HTTP 写接口支持 `Idempotency-Key` 头。
   - 重复回调不可能造成二次占位或二次退款。
6. **价格承诺锁价**：占位时取得带有效期的承诺；出票时供应方涨价仍按承诺价结算，现价差异以 `SUPPLIER_PRICE_CHANGED` 留痕。
7. **通知必须真正送达**：`NOTIFICATION_ATTEMPTED → DELIVERED/FAILED` 全程留痕；未送达的通知不能作为旅客知情确认的依据。
8. **全程可追溯**：偏好、价格承诺、通知回执、供应方单号、每笔资金都落在领域事件中。旅客有解释视图，客服有待办视图，争议处理可沿「承诺 → 占位 → 出票/退款事件 → 供应方单号」追到每笔钱。

## 目录

```
contracts/domain.schema.json   事件信封与枚举（只追加、不改语义的交换格式契约）
src/contracts.js               事件类型/聚合/动作枚举（与 schema 同步）
src/validator.js               信封基础校验（历史七字段样例仍合法）
src/domain/
  time.js                      当地时间、跨午夜夜切、MCT
  documents.js                 证件期限与受限成员
  store.js                     事件存储：event_id 去重、版本乐观锁
  aggregates.js                四个聚合的事件回放投影
  planner.js                   依赖传播 + 保留/改签/拆分/取消方案（纯函数）
src/suppliers/gateway.js       供应方网关：预订/候补/占位/出票/退款、回调与幂等
src/application/
  service.js                   命令侧：建档、回调、提案、冻结、通知、确认、过期、对账
  queries.js                   读侧：旅客解释 / 客服待办 / 争议资金链 / 时间线
src/http/server.js             node:http 适配层（无第三方依赖）
bin/serve.mjs                  本地启动入口
tests/                         单元 + 端到端 + HTTP 集成测试
```

## 四个聚合与既有事件

聚合：`travel_party`、`booking_segment`、`recovery_option`、`financial_resolution`。

仓库既有五个事件保持原位原义：`SEGMENT_CONFIRMED`、`DISRUPTION_RECEIVED`、`OPTION_PROPOSED`、`CHOICE_ACCEPTED`、`FUNDS_RECONCILED`；新事件一律**追加**在枚举末尾（见 `src/contracts.js`）。

## 协商流程（状态机）

```
供应方回调（waitlist_result/disruption，按 callback_id 去重）
   └─> propose   推荐「保联程」方案，同时附「逐单退款」对照
         └─> freeze    价格承诺 + 占位（不动原单），产出冻结快照与到期时刻
               ├─> notify   通知尝试 → delivered / failed（可重试）
               ├─> accept   仅 frozen 且未到期可确认；先全部出新票 → 登记选择 → 再退旧单 → 净补款 → 对账
               ├─> reject   释放全部占位
               └─> expire   到期未确认自动释放占位，原订单不受影响
```

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/parties` | 登记团队（成员、证件、偏好、通知地址） |
| POST | `/segments` | 登记行程段（依赖、时刻时区、价格、证件要求、酒店入住日夜切） |
| POST | `/callbacks` | 供应方回调入口（候补结果/中断；重复 callback_id 安全重放） |
| POST | `/parties/:id/propose` | 计算恢复方案 |
| POST | `/options/:id/freeze` | 冻结：占位 + 价格承诺 |
| POST | `/options/:id/notify` | 发送方案通知（返回送达状态） |
| POST | `/options/:id/accept` | 旅客确认（可附已送达通知 id 作为知情依据） |
| POST | `/options/:id/reject` | 拒绝并释放占位 |
| POST | `/admin/expire` | 过期扫描 |
| GET | `/options/:id/explanation` | 旅客视角：我选了什么、每段为什么这么处理 |
| GET | `/parties/:id/dashboard` | 客服视角：悬而未决项、通知送达、被拒回调 |
| GET | `/parties/:id/trail` | 争议视角：每笔资金的承诺/单号/事件链 |
| GET | `/correlations/:cid/timeline` | 一次协商的完整事件时间线 |

所有 POST 支持 `Idempotency-Key` 请求头。

## 本地运行与检查

```bash
npm test          # 28 个测试：时间/证件/存储/网关/状态机/端到端/HTTP
node bin/serve.mjs
PORT=9000 node bin/serve.mjs
```

端到端夹具（`tests/fixtures/scenario.js`）是一家四口 9.30 晚出发的联程：候补火车 → 国内航班 → 县城接驳/酒店，国内航班 → 境外航班 → 境外酒店；其中一名孩子护照有效期不足。测试覆盖：候补失败重复回调、冻结前后订单不变、供应方涨价仍按承诺价、通知失败不可确认、红眼保住酒店当晚、拆分同行、先新票后旧退、资金对账为零、占位到期释放等。

## 生产替换点

`RecoveryService` 的三个可注入依赖即生产边界：`EventStore`（换持久化数据库，`event_id` 与 `流+version` 建唯一索引）、`SupplierGateway`（换真实 12306/航司/酒店适配器）、`channels`（换短信/推送网关并回传送达回执）。领域层、事件契约与 HTTP 接口保持不变。
