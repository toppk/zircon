import { createWebHandler } from "./web.js";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export function openApi(config) {
  return {
    openapi: "3.1.0",
    info: { title: "Zircon IRC", version: "0.2.0", description: "Read and send messages in your configured IRC channels." },
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

export function createHandler(config, pool, store, getGithubIdentity) {
  const web = createWebHandler(config, store, pool, getGithubIdentity);
  const schema = openApi(config);
  return async request => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return json({ ok: true });
    if (request.method === "GET" && url.pathname === "/openapi.json") return json(schema);
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
    let irc;
    try { irc = await pool.forUser(user); } catch (error) {
      console.error("ZNC provisioning failed:", error.message);
      return json({ error: "IRC setup unavailable" }, 503);
    }
    if (url.pathname === "/v1/status") return json({ connected: irc.connected, joined_channels: [...irc.joined].filter(c => selected.has(c)).sort(), enabled_channels: [...selected].sort() });
    let name;
    try { name = decodeURIComponent(match[1]); } catch { return json({ error: "Invalid channel name" }, 400); }
    const channel = [...selected].find(item => item.slice(1).toLowerCase() === name.toLowerCase());
    if (!channel || !selected.has(channel)) return json({ error: "Unknown channel" }, 404);
    if (request.method === "GET") {
      const rawLimit = url.searchParams.get("limit") ?? "50";
      if (!/^[0-9]+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200) return json({ error: "limit must be 1 to 200" }, 400);
      return json({ messages: irc.messages(channel, Number(rawLimit)) });
    }
    if (!store.allowRate(`post:${user.id}`, 20, 60_000)) return json({ error: "Too many messages" }, 429);
    let payload;
    try { payload = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    const message = payload && typeof payload === "object" ? payload.text : null;
    if (typeof message !== "string" || message.length < 1 || message.length > 400 || /[\r\n\x00-\x1f]/.test(message)) return json({ error: "text must be one line of 1 to 400 characters" }, 422);
    try { irc.sendMessage(channel, message); } catch (error) {
      if (error instanceof RangeError) return json({ error: error.message }, 422);
      return json({ error: "IRC channel is unavailable" }, 503);
    }
    store.auditPost(user, channel, message);
    return json({ accepted: true, channel }, 202);
  };
}
