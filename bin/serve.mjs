#!/usr/bin/env node
/**
 * 开发启动：内存事件存储 + 模拟供应方网关的 HTTP 服务。
 *   node bin/serve.mjs            # 默认端口 8787
 *   PORT=9000 node bin/serve.mjs
 *
 * 生产部署把 RecoveryService 的 EventStore / SupplierGateway / channels
 * 换成持久化与真实供应方适配器即可，领域层与 HTTP 契约不变。
 */
import { RecoveryService, SupplierGateway, createServer } from "../src/index.js";

const service = new RecoveryService({
  gateway: new SupplierGateway(),
  channels: {
    sms: async (m) => ({ provider_id: `sms-dev-${Date.now()}`, detail: `开发环境短信：${m.summary ?? ""}` }),
    app_push: async (m) => ({ provider_id: `push-dev-${Date.now()}`, detail: m.summary }),
  },
});
const port = Number(process.env.PORT ?? 8787);
createServer(service).listen(port, () => {
  console.log(`假期联程保障协商后端已启动：http://127.0.0.1:${port}`);
  console.log("健康检查：GET /health");
});
