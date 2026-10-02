import { createWebHandler } from "./web.js";
import { createMcpHandler } from "./mcp.js";
import { EventService } from "./events.js";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export function openApi(config) {
  return {
    openapi: "3.1.0",
    info: { title: "Zircon IRC", version: "0.6.0", description: "Read and send messages in your configured IRC channels." },
    servers: [{ url: config.publicBaseUrl }],
    components: { securitySchemes: { zirconOAuth: { type: "oauth2", flows: { authorizationCode: {
      authorizationUrl: `${config.publicBaseUrl}/oauth/authorize`, tokenUrl: `${config.publicBaseUrl}/oauth/token`,
      scopes: { "irc:read": "Read allowed IRC channels", "irc:write": "Send messages to allowed IRC channels" },
    } } } } },
    paths: {
      "/v1/status": { get: { operationId: "getIrcStatus", summary: "Check IRC connection and your enabled channels",
        security: [{ zirconOAuth: ["irc:read"] }], responses: { "200": { description: "IRC status" } } } },
      "/v1/channels/{channel}/messages": {
        parameters: [{ name: "channel", in: "path", required: true, description: "Channel name without the leading #", schema: { type: "string" } }],
        get: { operationId: "getChannelMessages", summary: "Read recent IRC messages", security: [{ zirconOAuth: ["irc:read"] }],
          parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } }],
          responses: { "200": { description: "Recent messages" } } },
        post: { operationId: "sendChannelMessage", summary: "Send one IRC message", security: [{ zirconOAuth: ["irc:write"] }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 400 } } } } } },
          responses: { "202": { description: "Message queued" } } },
      },
    },
  };
}

export function createHandler(config, pool, store, getGithubIdentity, eventService = new EventService(store)) {
  const web = createWebHandler(config, store, pool, getGithubIdentity);
  const mcp = createMcpHandler(config, store, pool, eventService);
  const schema = openApi(config);
  return async request => {
    const url = new URL(request.url, config.publicBaseUrl);
    if (request.method === "GET" && url.pathname === "/healthz") return json({ ok: true });
    if (request.method === "GET" && url.pathname === "/openapi.json") return json(schema);
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      if (!config.diagnosticsEnabled) return mcp(request);
      let call;
      if (request.method === "POST") {
        try { call = await request.clone().json(); } catch { /* malformed requests are still logged */ }
      }
      const method = typeof call?.method === "string" && /^[a-zA-Z0-9/_-]{1,80}$/.test(call.method)
        ? call.method : request.method;
      const tool = method === "tools/call" && /^[a-z0-9_]{1,64}$/.test(call?.params?.name ?? "")
        ? `:${call.params.name}` : "";
      const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
      const user = store.accessUser(token, "irc:read", config.publicBaseUrl) ??
        store.accessUser(token, "irc:write", config.publicBaseUrl);
      const reply = await mcp(request);
      let result = String(reply.status);
      try {
        const body = await reply.clone().json();
        if (typeof body?.error?.code === "number") result += `/${body.error.code}`;
      } catch { /* notifications and empty replies have no JSON body */ }
      try { store.recordDiagnostic(user, "mcp", `${method}${tool}`, result); }
      catch (error) { console.error("Could not record MCP diagnostic:", error.message); }
      return reply;
    }
    const webResponse = await web(request);
    if (webResponse) return webResponse;
    const match = /^\/v1\/channels\/([^/]+)\/messages$/.exec(url.pathname);
    if (url.pathname !== "/v1/status" && !match) return json({ error: "Not found" }, 404);
    if (url.pathname === "/v1/status" && request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    if (match && !["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed" }, 405);
    const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const user = store.accessUser(token, request.method === "POST" ? "irc:write" : "irc:read");
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" } });
    const selected = new Set(JSON.parse(user.selected_channels));
    if (url.pathname === "/v1/status") {
      if (!user.online) return json({ connected: false, joined_channels: [], enabled_channels: [...selected].sort(), online: false });
      let irc;
      try { irc = await pool.forUser(user); } catch (error) {
        console.error("ZNC provisioning failed:", error.message);
        return json({ error: "IRC setup unavailable" }, 503);
      }
      return json({ connected: irc.connected, joined_channels: [...irc.joined].filter(c => selected.has(c)).sort(), enabled_channels: [...selected].sort(), online: true });
    }
    let name;
    try { name = decodeURIComponent(match[1]); } catch { return json({ error: "Invalid channel name" }, 400); }
    const channel = [...selected].find(item => item.slice(1).toLowerCase() === name.toLowerCase());
    if (!channel || !selected.has(channel)) return json({ error: "Unknown channel" }, 404);
    if (request.method === "GET") {
      const rawLimit = url.searchParams.get("limit") ?? "50";
      if (!/^[0-9]+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200) return json({ error: "limit must be 1 to 200" }, 400);
      return json({ messages: store.recentActivity(user, channel, Number(rawLimit)).filter(item => item.kind === "message") });
    }
    if (!store.allowRate(`post:${user.id}`, 20, 60_000)) return json({ error: "Too many messages" }, 429);
    let payload;
    try { payload = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    const message = payload && typeof payload === "object" ? payload.text : null;
    if (typeof message !== "string" || message.length < 1 || message.length > 400 || /[\r\n\x00-\x1f]/.test(message)) return json({ error: "text must be one line of 1 to 400 characters" }, 422);
    let irc;
    try { irc = await pool.forUser(user); } catch (error) {
      console.error("ZNC provisioning failed:", error.message);
      return json({ error: "IRC setup unavailable" }, 503);
    }
    try { irc.sendMessage(channel, message); } catch (error) {
      if (error instanceof RangeError) return json({ error: error.message }, 422);
      return json({ error: "IRC channel is unavailable" }, 503);
    }
    store.auditPost(user, channel, message);
    const time = new Date().toISOString();
    store.recordActivity(user, { channel, kind: "message", time, observedAt: time, timestampSource: "local", nick: user.nick, text: message });
    return json({ accepted: true, channel }, 202);
  };
}
