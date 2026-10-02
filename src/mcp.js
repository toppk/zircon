const object = properties => ({ type: "object", properties, additionalProperties: false });
const string = { type: "string" };
const entry = { ...object({ entryId: string, messageId: { type: ["string", "null"] },
  network: string, channel: string, kind: string,
  time: string, observedAt: string, timestampSource: { type: "string", enum: ["server", "observed", "local"] },
  nick: string, text: string, target: { type: ["string", "null"] } }),
  required: ["entryId", "messageId", "network", "channel", "kind", "time", "observedAt", "timestampSource", "nick", "text", "target"] };
const cursor = { type: ["string", "null"] };
const received = { ...object({ entryId: string, kind: string, channel: string, observedAt: string }),
  required: ["entryId", "kind", "channel", "observedAt"] };
const tools = [
  {
    name: "list_channels", title: "List IRC channels",
    description: "List the IRC network and channels this signed-in user has enabled in Zircon settings. online is the requested upstream presence; connection reports Zircon's local ZNC session, which may still be connecting. Use this before reading a channel.",
    inputSchema: object({}),
    outputSchema: { ...object({ network: string, channels: { type: "array", items: string }, online: { type: "boolean" },
      connection: { type: "string", enum: ["offline", "connecting", "connected"] },
      unread: { type: "object", additionalProperties: { type: "integer" } } }), required: ["network", "channels", "online", "connection", "unread"] },
    securitySchemes: [{ type: "oauth2", scopes: ["irc:read"] }],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "read_unread", title: "Read unread IRC activity",
    description: "Read the next unacknowledged batch in a channel, oldest arrival first. The same batch is returned until ack_messages succeeds. Each entry includes a mention flag, IRC event time, local observed time, and timestamp source. Use this for normal reading; then acknowledge only after processing it.",
    inputSchema: { ...object({ channel: string, limit: { type: "integer", minimum: 1, maximum: 200 } }), required: ["channel"] },
    outputSchema: { ...object({ channel: string, network: string, batchId: cursor, hasMore: { type: "boolean" },
      entries: { type: "array", items: { ...entry, properties: { ...entry.properties, mention: { type: "boolean" } },
        required: [...entry.required, "mention"] } } }), required: ["channel", "network", "batchId", "hasMore", "entries"] },
    securitySchemes: [{ type: "oauth2", scopes: ["irc:read"] }],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "ack_messages", title: "Acknowledge IRC messages",
    description: "Acknowledge a read_unread batch after processing it. This advances that agent's channel cursor; retrying the same acknowledgement is safe.",
    inputSchema: { ...object({ batch_id: string }), required: ["batch_id"] },
    outputSchema: { ...object({ acknowledged: { type: "boolean" } }), required: ["acknowledged"] },
    securitySchemes: [{ type: "oauth2", scopes: ["irc:read"] }],
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_history", title: "Browse older IRC activity",
    description: "Browse retained channel activity, newest first. Pass nextBefore for the next page. This does not change unread state.",
    inputSchema: { ...object({ channel: string, before: string,
      limit: { type: "integer", minimum: 1, maximum: 200 } }), required: ["channel"] },
    outputSchema: { ...object({ network: string, channel: string, entries: { type: "array", items: entry },
      nextBefore: cursor }), required: ["network", "channel", "entries", "nextBefore"] },
    securitySchemes: [{ type: "oauth2", scopes: ["irc:read"] }],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "search_messages", title: "Search IRC messages",
    description: "Search retained messages in this user's enabled channels using a case-insensitive exact phrase. Results are newest first. Optional UTC since and until narrow the period; pass nextBefore to continue. Search does not change unread state.",
    inputSchema: { ...object({ query: { type: "string", minLength: 1, maxLength: 100 }, channel: string,
      since: { type: "string", format: "date-time" }, until: { type: "string", format: "date-time" },
      before: string, limit: { type: "integer", minimum: 1, maximum: 100 } }), required: ["query"] },
    outputSchema: { ...object({ messages: { type: "array", items: entry }, nextBefore: cursor }), required: ["messages", "nextBefore"] },
    securitySchemes: [{ type: "oauth2", scopes: ["irc:read"] }],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "send_message", title: "Send an IRC channel message",
    description: "Post one message to an enabled IRC channel under this user's nick. This is a public write action: confirm the exact channel and text with the user, unless they gave standing authorization for replies in this channel and chat. A successful result means queued to ZNC, never confirmed delivered. Reuse the same idempotency_key on retries; messageId stays stable.",
    inputSchema: { ...object({ channel: string, text: { type: "string", minLength: 1, maxLength: 400 },
      idempotency_key: { type: "string", minLength: 8, maxLength: 128 } }), required: ["channel", "text", "idempotency_key"] },
    outputSchema: { ...object({ status: { type: "string", enum: ["queued", "pending", "echoed"] }, network: string,
      channel: string, messageId: string }), required: ["status", "network", "channel", "messageId"] },
    securitySchemes: [{ type: "oauth2", scopes: ["irc:write"] }],
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "get_message_status", title: "Check an outgoing message",
    description: "Check what Zircon knows about one send_message result. queued means written to the local ZNC socket; echoed means Zircon later observed a matching line through ZNC. Neither proves another person saw it. Failed requests can be retried with the original idempotency key.",
    inputSchema: { ...object({ message_id: string }), required: ["message_id"] },
    outputSchema: { ...object({ messageId: string, network: string, channel: string,
      status: { type: "string", enum: ["pending", "queued", "echoed", "failed"] },
      createdAt: string, echoedAt: cursor, entryId: cursor, failureReason: cursor }),
      required: ["messageId", "network", "channel", "status", "createdAt", "echoedAt", "entryId", "failureReason"] },
    securitySchemes: [{ type: "oauth2", scopes: ["irc:read"] }],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_irc_status", title: "Check IRC capture and event delivery",
    description: "Inspect the current nick, Zircon's local ZNC session, ZNC's upstream IRC connection, joined channels, most recently captured activity, and mention subscription delivery health. A connected ZNC session alone does not prove upstream readiness; finite ZNC buffers mean capture continuity cannot be guaranteed after a disconnect.",
    inputSchema: object({}),
    outputSchema: { ...object({ nick: string, network: string, online: { type: "boolean" },
      zncSession: { type: "string", enum: ["offline", "connecting", "connected"] },
      upstreamConnected: { type: ["boolean", "null"] }, joinedChannels: { type: "array", items: string },
      lastReceived: { anyOf: [received, { type: "null" }] }, captureGapPossibleSince: cursor,
      captureContinuity: { type: "string", enum: ["unverified"] },
      activeSubscriptions: { type: "integer" }, pendingDeliveries: { type: "integer" },
      lastEventAttemptAt: cursor, lastEventDeliveryStatus: cursor }),
      required: ["nick", "network", "online", "zncSession", "upstreamConnected", "joinedChannels",
        "lastReceived", "captureGapPossibleSince", "captureContinuity", "activeSubscriptions",
        "pendingDeliveries", "lastEventAttemptAt", "lastEventDeliveryStatus"] },
    securitySchemes: [{ type: "oauth2", scopes: ["irc:read"] }],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  ...[false, true].map(online => ({
    name: online ? "go_online" : "go_offline", title: online ? "Go online on IRC" : "Go offline on IRC",
    description: online
      ? "Request reconnection of this user's approved IRC network. The result may say connecting while Zircon authenticates its local ZNC session; it does not prove an upstream channel join. Staying online lets Zircon record new activity and deliver subscribed mention events."
      : "Disconnect this user's upstream IRC network and stop receiving new activity or events. Retained history stays readable. Use only when the user wants to pause their IRC presence.",
    inputSchema: object({}),
    outputSchema: { ...object({ online: { type: "boolean" }, network: string,
      connection: { type: "string", enum: ["offline", "connecting", "connected"] } }), required: ["online", "network", "connection"] },
    securitySchemes: [{ type: "oauth2", scopes: ["irc:write"] }],
    annotations: { readOnlyHint: false, destructiveHint: !online, openWorldHint: true },
  })),
];

const response = (body, status = 200, headers = {}) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", ...headers },
});
const rpc = (id, value) => response({ jsonrpc: "2.0", id, ...value });
const error = (id, code, message) => rpc(id, { error: { code, message } });
const result = (id, data) => rpc(id, { result: data });
const toolResult = (id, data) => result(id, { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] });

export function createMcpHandler(config, store, pool, events) {
  const challenge = scope => `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource", scope="${scope}"`;
  return async request => {
    const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const readPrincipal = store.accessPrincipal(bearer, "irc:read", config.publicBaseUrl);
    const writePrincipal = store.accessPrincipal(bearer, "irc:write", config.publicBaseUrl);
    const readUser = readPrincipal?.user;
    const writeUser = writePrincipal?.user;
    const user = readUser ?? writeUser;
    if (!user) return response({ error: "Unauthorized" }, 401, { "WWW-Authenticate": challenge("irc:read") });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    let call;
    try { call = await request.json(); } catch { return error(null, -32700, "Invalid JSON"); }
    if (!call || typeof call !== "object" || Array.isArray(call) || call.jsonrpc !== "2.0" || typeof call.method !== "string") {
      return error(null, -32600, "Invalid request");
    }
    if (call.id === undefined) return new Response(null, { status: 202 });
    if (call.method === "server/discover") return result(call.id, {
      resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {}, events: {} },
    });
    if (call.method === "initialize") return result(call.id, {
      protocolVersion: call.params?.protocolVersion === "2026-07-28" ? "2026-07-28" : "2025-06-18",
      capabilities: { tools: { listChanged: false }, events: {} },
      serverInfo: { name: "zircon-irc", title: "Zircon IRC", version: "0.6.0" },
      instructions: "Use list_channels, then read_unread for normal channel reading. Process each batch and call ack_messages with its batchId; unacknowledged batches are returned again. get_history and search_messages do not change unread state. Staying online records new activity and delivers subscribed mention events. Sending an IRC message is public and irreversible; confirm its destination and text unless the user explicitly authorized automatic replies in this chat and channel.",
    });
    if (call.method === "ping") return result(call.id, {});
    if (call.method === "tools/list") return result(call.id, { tools });
    if (call.method === "events/list") {
      if (!readPrincipal) return response({ error: "Unauthorized" }, 401, { "WWW-Authenticate": challenge("irc:read") });
      return result(call.id, { events: [{
        name: "message.mention", description: "A message in a joined IRC channel addresses your current IRC nick. Zircon must stay online to deliver it.",
        delivery: ["webhook"],
        inputSchema: object({ network: string, channel: string, sender: string, keyword: string }),
        payloadSchema: { ...object({ network: string, channel: string, sender: string, text: string,
          kind: string, observedAt: string, entryId: string }),
          required: ["network", "channel", "sender", "text", "kind", "observedAt", "entryId"] },
      }] });
    }
    if (call.method === "events/subscribe" || call.method === "events/unsubscribe") {
      if (!readPrincipal) return response({ error: "Unauthorized" }, 401, { "WWW-Authenticate": challenge("irc:read") });
      const params = call.params ?? {};
      const filters = params.arguments ?? {};
      const delivery = params.delivery ?? {};
      const selected = JSON.parse(user.selected_channels);
      const allowedFilter = key => ["network", "channel", "sender", "keyword"].includes(key);
      if (params.name !== "message.mention" || !filters || typeof filters !== "object" || Array.isArray(filters) ||
          Object.entries(filters).some(([key, value]) => !allowedFilter(key) || typeof value !== "string" ||
            !value || value.length > 100) ||
          (filters.network && filters.network !== user.network_name) ||
          (filters.channel && !selected.some(channel => channel.toLowerCase() === filters.channel.toLowerCase())) ||
          delivery.mode !== "webhook" || !validCallbackUrl(delivery.url)) {
        return error(call.id, -32602, "Invalid event, filters, or callback URL");
      }
      if (call.method === "events/unsubscribe") {
        store.removeEventSubscription(user, readPrincipal.clientId, params.name, filters, delivery.url);
        return result(call.id, {});
      }
      const ttl = params.ttlMs === undefined ? 86_400_000 : params.ttlMs;
      if ((ttl !== null && (!Number.isInteger(ttl) || ttl < 0)) ||
          !validWebhookSecret(delivery.secret) || (params.cursor !== undefined && params.cursor !== null)) {
        return error(call.id, -32602, "Invalid event lifetime, secret, or cursor");
      }
      const id = store.eventSubscriptionId(user, readPrincipal.clientId, params.name, filters, delivery.url);
      const subscriptions = store.listEventSubscriptions(user);
      if (!subscriptions.some(subscription => subscription.id === id) && subscriptions.length >= 20) {
        return error(call.id, -32000, "Subscription limit reached");
      }
      if (!store.allowRate(`event-subscribe:${user.id}`, 12, 60_000) ||
          !store.allowRate("event-subscribe:global", 100, 60_000)) {
        return error(call.id, -32000, "Subscription rate limit reached");
      }
      let verified = false;
      try { verified = await events.verify(delivery.url, delivery.secret, id); }
      catch (cause) { console.error("Event callback verification failed:", cause.message); }
      if (!verified) return rpc(call.id, { error: { code: -32015, message: "Callback verification failed",
        data: { reason: "challenge_failed" } } });
      const expiresAt = ttl === null ? null : Date.now() + Math.max(300_000, Math.min(ttl, 7 * 86_400_000));
      store.saveEventSubscription(user, readPrincipal.clientId, params.name, filters, delivery.url, delivery.secret, expiresAt);
      return result(call.id, { id, refreshBefore: expiresAt === null ? null : new Date(expiresAt).toISOString(),
        cursor: null, truncated: false });
    }
    if (call.method !== "tools/call") return error(call.id, -32601, "Method not found");
    const name = call.params?.name;
    const args = call.params?.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) return error(call.id, -32602, "Invalid arguments");
    const writeTool = ["go_online", "go_offline", "send_message"].includes(name);
    if (!(writeTool ? writeUser : readUser)) return response({ error: "Unauthorized" }, 401, { "WWW-Authenticate": challenge(writeTool ? "irc:write" : "irc:read") });
    if (name === "list_channels") {
      if (Object.keys(args).length) return error(call.id, -32602, "Invalid arguments");
      const channels = JSON.parse(user.selected_channels);
      return toolResult(call.id, { network: user.network_name, channels, online: Boolean(user.online),
        connection: pool.connectionState?.(user) ?? (user.online ? "connecting" : "offline"),
        unread: Object.fromEntries(channels.map(channel => [channel, store.unreadCount(user, readPrincipal.clientId, channel)])) });
    }
    if (name === "read_unread" || name === "get_history") {
      const channels = JSON.parse(user.selected_channels);
      const channel = typeof args.channel === "string" ? channels.find(item => item.toLowerCase() === args.channel.toLowerCase()) : null;
      const limit = args.limit ?? 50;
      if (!channel || !Number.isInteger(limit) || limit < 1 || limit > 200 ||
          Object.keys(args).some(key => !["channel", "limit", ...(name === "get_history" ? ["before"] : [])].includes(key))) {
        return error(call.id, -32602, "Unknown channel or invalid limit");
      }
      if (name === "read_unread") return toolResult(call.id, { network: user.network_name, channel,
        ...store.readUnread(user, readPrincipal.clientId, channel, limit) });
      const history = store.getHistory(user, channel, args.before, limit);
      if (!history) return error(call.id, -32602, "Invalid history cursor");
      return toolResult(call.id, { network: user.network_name, channel, ...history });
    }
    if (name === "ack_messages") {
      if (typeof args.batch_id !== "string" || !/^batch_[A-Za-z0-9_-]{32,64}$/.test(args.batch_id) ||
          Object.keys(args).some(key => key !== "batch_id")) return error(call.id, -32602, "Invalid batch ID");
      if (!store.ackMessages(user, readPrincipal.clientId, args.batch_id)) return error(call.id, -32602, "Unknown batch");
      return toolResult(call.id, { acknowledged: true });
    }
    if (name === "get_message_status") {
      if (typeof args.message_id !== "string" || !/^msg_[A-Za-z0-9_-]{24}$/.test(args.message_id) ||
          Object.keys(args).some(key => key !== "message_id")) return error(call.id, -32602, "Invalid message ID");
      const status = store.postStatus(user, args.message_id);
      if (!status) return error(call.id, -32602, "Unknown message ID");
      return toolResult(call.id, status);
    }
    if (name === "get_irc_status") {
      if (Object.keys(args).length) return error(call.id, -32602, "Invalid arguments");
      if (!store.allowRate(`status:${user.id}`, 10, 60_000)) return error(call.id, -32000, "Status rate limit reached");
      let upstreamConnected = null;
      try { upstreamConnected = await pool.provisioner?.networkStatus?.(user) ?? null; }
      catch (cause) { console.error("Could not query ZNC upstream status:", cause.message); }
      const client = pool.clients?.get(user.id);
      const enabled = new Set(JSON.parse(user.selected_channels).map(channel => channel.toLowerCase()));
      const status = store.captureStatus(user);
      return toolResult(call.id, { nick: user.nick, network: user.network_name, online: Boolean(user.online),
        zncSession: pool.connectionState?.(user) ?? (user.online ? "connecting" : "offline"),
        upstreamConnected, joinedChannels: [...(client?.joined ?? [])].filter(channel => enabled.has(channel.toLowerCase())),
        lastReceived: status.lastReceived, captureGapPossibleSince: status.captureGapPossibleSince,
        captureContinuity: "unverified", activeSubscriptions: status.activeSubscriptions,
        pendingDeliveries: status.pendingDeliveries, lastEventAttemptAt: status.lastEventAttemptAt,
        lastEventDeliveryStatus: status.lastEventDeliveryStatus });
    }
    if (name === "search_messages") {
      const channels = JSON.parse(user.selected_channels);
      const channel = typeof args.channel === "string" ? channels.find(item => item.toLowerCase() === args.channel.toLowerCase()) : null;
      const validTime = value => value === undefined || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
      const limit = args.limit ?? 50;
      if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 100 ||
          (args.channel !== undefined && !channel) || !validTime(args.since) || !validTime(args.until) ||
          !Number.isInteger(limit) || limit < 1 || limit > 100 ||
          Object.keys(args).some(key => !["query", "channel", "since", "until", "before", "limit"].includes(key))) {
        return error(call.id, -32602, "Invalid search arguments");
      }
      const page = store.searchPage(user, channel ? [channel] : channels,
        args.query.trim(), args.since ? new Date(args.since).toISOString() : null,
        args.until ? new Date(args.until).toISOString() : null, args.before, limit);
      if (!page) return error(call.id, -32602, "Invalid search cursor");
      return toolResult(call.id, page);
    }
    if (name === "send_message") {
      const selected = JSON.parse(user.selected_channels);
      const channel = typeof args.channel === "string" ? selected.find(item => item.toLowerCase() === args.channel.toLowerCase()) : null;
      const message = args.text;
      const key = args.idempotency_key;
      if (!channel || typeof message !== "string" || message.length < 1 || message.length > 400 ||
          /[\r\n\x00-\x1f]/.test(message) || typeof key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(key) ||
          Object.keys(args).some(item => !["channel", "text", "idempotency_key"].includes(item))) {
        return error(call.id, -32602, "Invalid channel, message, or idempotency key");
      }
      if (!user.online) return error(call.id, -32603, "IRC is offline; ask the user before going online");
      const reservation = store.reservePost(user, key, channel, message);
      if (reservation === "conflict") return error(call.id, -32602, "Idempotency key was used for a different message");
      const messageId = store.outgoingMessageId(user, key);
      if (reservation !== "new") return toolResult(call.id, { status: reservation, network: user.network_name, channel, messageId });
      if (!store.allowRate(`post:${user.id}`, 20, 60_000) || !store.allowRate(`post:network:${user.network_name}`, 60, 60_000)) {
        store.failPost(user, key, "rate_limited");
        return error(call.id, -32000, "Message rate limit reached");
      }
      try {
        const irc = await pool.forUser(user);
        irc.sendMessage(channel, message);
      } catch (cause) {
        store.failPost(user, key, "channel_unavailable");
        console.error("MCP IRC post failed:", cause.message);
        return error(call.id, -32603, "IRC channel unavailable");
      }
      store.completePost(user, key);
      store.auditPost(user, channel, message);
      return toolResult(call.id, { status: "queued", network: user.network_name, channel, messageId });
    }
    if (writeTool) {
      if (Object.keys(args).length) return error(call.id, -32602, "Invalid arguments");
      try { await pool.setOnline(user, name === "go_online"); }
      catch (cause) { console.error("MCP IRC presence change failed:", cause.message); return error(call.id, -32603, "IRC presence change unavailable"); }
      const online = name === "go_online";
      return toolResult(call.id, { online, network: user.network_name,
        connection: pool.connectionState?.({ ...user, online }) ?? (online ? "connecting" : "offline") });
    }
    return error(call.id, -32601, "Unknown tool");
  };
}
import { validCallbackUrl, validWebhookSecret } from "./events.js";
