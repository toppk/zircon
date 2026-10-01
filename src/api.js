import { AuthError } from "./auth.js";

function json(body, status = 200, headers) {
  return Response.json(body, { status, headers });
}

export function openApi(config) {
  return {
    openapi: "3.1.0",
    info: { title: "Zircon IRC", version: "0.1.0", description: "Read and send messages in configured IRC channels." },
    servers: [{ url: config.publicBaseUrl }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      schemas: {
        Message: {
          type: "object", required: ["time", "channel", "nick", "text"],
          properties: { time: { type: "string", format: "date-time" }, channel: { type: "string" }, nick: { type: "string" }, text: { type: "string" } },
        },
      },
    },
    paths: {
      "/v1/status": { get: {
        operationId: "getIrcStatus", summary: "Check IRC connection and joined channels", security: [{ bearerAuth: [] }],
        responses: { "200": { description: "IRC status" } },
      } },
      "/v1/channels/{channel}/messages": {
        parameters: [{ name: "channel", in: "path", required: true, description: "Allowed channel name without the leading #", schema: { type: "string" } }],
        get: {
          operationId: "getChannelMessages", summary: "Read recent IRC channel messages", security: [{ bearerAuth: [] }],
          parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } }],
          responses: { "200": { description: "Recent messages", content: { "application/json": { schema: { type: "object", properties: { messages: { type: "array", items: { $ref: "#/components/schemas/Message" } } } } } } } },
        },
        post: {
          operationId: "sendChannelMessage", summary: "Send one IRC channel message", security: [{ bearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["text"], properties: { text: { type: "string", minLength: 1, maxLength: 400 } } } } } },
          responses: { "202": { description: "Message queued to the IRC socket" } },
        },
      },
    },
  };
}

export function createHandler(config, irc, verifier) {
  const allowedChannels = new Map(config.ircChannels.map(channel => [channel.slice(1).toLowerCase(), channel]));
  const schema = openApi(config);
  return async request => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return json({ ok: true });
    if (request.method === "GET" && url.pathname === "/openapi.json") return json(schema);
    const channelMatch = /^\/v1\/channels\/([^/]+)\/messages$/.exec(url.pathname);
    if (url.pathname !== "/v1/status" && !channelMatch) return json({ error: "Not found" }, 404);
    if (url.pathname === "/v1/status" && request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    if (channelMatch && !["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed" }, 405);

    const scope = request.method === "POST" ? "irc:write" : "irc:read";
    try {
      await verifier.verify(request.headers.get("authorization"), scope);
    } catch (error) {
      if (error instanceof AuthError) {
        return json({ error: error.message }, error.status, error.status === 401 ? { "WWW-Authenticate": "Bearer" } : undefined);
      }
      console.error("Token verification failed:", error);
      return json({ error: "Authentication service unavailable" }, 503);
    }
    if (url.pathname === "/v1/status") return json({ connected: irc.connected, joined_channels: [...irc.joined].sort() });

    let channelName;
    try {
      channelName = decodeURIComponent(channelMatch[1]);
    } catch {
      return json({ error: "Invalid channel name" }, 400);
    }
    const channel = allowedChannels.get(channelName.toLowerCase());
    if (!channel) return json({ error: "Unknown channel" }, 404);
    if (request.method === "GET") {
      const rawLimit = url.searchParams.get("limit") ?? "50";
      if (!/^[0-9]+$/.test(rawLimit)) return json({ error: "limit must be an integer from 1 to 200" }, 400);
      const limit = Number(rawLimit);
      if (limit < 1 || limit > 200) return json({ error: "limit must be an integer from 1 to 200" }, 400);
      return json({ messages: irc.messages(channel, limit) });
    }
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    const text = typeof payload === "object" && payload !== null && "text" in payload ? payload.text : undefined;
    if (typeof text !== "string" || text.length < 1 || text.length > 400 || /[\r\n\x00]/.test(text)) {
      return json({ error: "text must be a single line of 1 to 400 characters" }, 422);
    }
    try {
      irc.sendMessage(channel, text);
    } catch (error) {
      if (error instanceof RangeError) return json({ error: error.message }, 422);
      return json({ error: "IRC channel is unavailable" }, 503);
    }
    return json({ accepted: true, channel }, 202);
  };
}
