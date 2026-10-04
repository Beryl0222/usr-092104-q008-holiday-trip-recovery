/**
 * HTTP 适配层（无第三方依赖，node:http）。
 *
 * 所有写接口支持 `Idempotency-Key` 请求头：同键重放首次响应，
 * 与领域事件 event_id 去重、供应方幂等键一起构成第三道防重防线。
 */

import http from "node:http";
import { agentDashboard, customerExplanation, disputeTrail, timeline } from "../application/queries.js";

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("请求体过大"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });

export function createServer(service) {
  const idemResponses = new Map(); // Idempotency-Key -> {status, body}

  const routes = [];
  const route = (method, pattern, handler) => {
    const names = [];
    const re = new RegExp(`^${pattern.replace(/:([a-z_]+)/g, (_, n) => {
      names.push(n);
      return "([^/]+)";
    })}$`);
    routes.push({ method, re, names, handler });
  };

  // ---- 写接口：处理器返回 {status, body} ----
  route("POST", "/parties", async (req, body) => {
    const agg = service.registerParty(body);
    return { status: 201, body: { party_id: agg.aggregateId, version: agg.version } };
  });

  route("POST", "/segments", async (req, body) => {
    const agg = service.registerSegment(body);
    return { status: 201, body: { segment_id: agg.aggregateId, version: agg.version, status: agg.state.status } };
  });

  route("POST", "/callbacks", async (req, body) => {
    const result = service.receiveSupplierCallback(body);
    return { status: result.rejected ? 422 : 200, body: result };
  });

  route("POST", "/parties/:id/propose", async (req, body) => {
    const { option_id, plan } = service.propose({ party_id: req.params.id, ...body });
    return { status: 201, body: { option_id, plan } };
  });

  route("POST", "/options/:id/freeze", async (req, body) => {
    const agg = service.freeze({ option_id: req.params.id, ...body });
    return {
      status: 200,
      body: {
        option_id: agg.aggregateId,
        status: agg.state.status,
        expires_at: agg.state.expires_at,
        totals: agg.state.totals,
        pending_suppliers: agg.state.pending_suppliers,
        summary: agg.state.freeze_summary,
        holds: agg.state.holds.map((h) => ({ hold_id: h.hold_id, supplier: h.supplier, amount: h.amount, expires_at: h.expires_at })),
      },
    };
  });

  route("POST", "/options/:id/notify", async (req, body) => {
    const result = await service.notifyFrozen({ option_id: req.params.id, ...body });
    return { status: result.state === "delivered" ? 200 : 502, body: result };
  });

  route("POST", "/options/:id/accept", async (req, body) => {
    try {
      const result = service.accept({ option_id: req.params.id, ...body });
      return { status: 200, body: result };
    } catch (err) {
      return { status: err.code === "OPTION_EXPIRED" ? 410 : 409, body: { error: err.message, code: err.code ?? null } };
    }
  });

  route("POST", "/options/:id/reject", async (req, body) => {
    const agg = service.reject({ option_id: req.params.id, ...body });
    return { status: 200, body: { option_id: agg.aggregateId, status: agg.state.status } };
  });

  route("POST", "/admin/expire", async (req, body) => {
    const expired = service.expireIfDue(body.option_id ?? null);
    return { status: 200, body: { expired_option_ids: expired } };
  });

  // ---- 读接口 ----
  route("GET", "/options/:id/explanation", async (req) => ({
    status: 200,
    body: customerExplanation(service.store, req.params.id),
  }));
  route("GET", "/parties/:id/dashboard", async (req) => ({
    status: 200,
    body: agentDashboard(service.store, req.params.id),
  }));
  route("GET", "/parties/:id/trail", async (req) => ({
    status: 200,
    body: disputeTrail(service.store, req.params.id),
  }));
  route("GET", "/correlations/:cid/timeline", async (req) => ({
    status: 200,
    body: { correlation_id: req.params.cid, events: timeline(service.store, req.params.cid) },
  }));
  route("GET", "/health", async () => ({ status: 200, body: { ok: true } }));

  const writeJson = (res, status, body, extraHeaders = {}) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...extraHeaders });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!match) return writeJson(res, 404, { error: "未找到接口" });
    const m = match.re.exec(url.pathname);
    req.params = Object.fromEntries(match.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));

    const idemKey = req.headers["idempotency-key"];
    if (idemKey && req.method === "POST" && idemResponses.has(idemKey)) {
      const first = idemResponses.get(idemKey);
      return writeJson(res, first.status, { ...first.body, replayed: true });
    }

    try {
      const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : {};
      const { status, body: payload, headers } = await match.handler(req, body);
      if (idemKey && req.method === "POST" && status < 500) idemResponses.set(idemKey, { status, body: payload });
      writeJson(res, status, payload, headers);
    } catch (err) {
      const status =
        err.code === "DUPLICATE_EVENT" || err.code === "VERSION_CONFLICT" ? 409
        : err.name === "SupplierError" ? 502
        : 400;
      writeJson(res, status, { error: err.message, code: err.code ?? err.name ?? null });
    }
  });

  return server;
}
