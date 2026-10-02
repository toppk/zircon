import { version } from "./version.js";
import { tools, summarizeEventState } from "./mcp-tools.js";
import { validCallbackUrl, validWebhookSecret } from "./events.js";

const object = properties => ({ type: "object", properties, additionalProperties: false });
const string = { type: "string" };
const validSessionId = value => typeof value === "string" && /^agent_[A-Za-z0-9_-]{43}$/.test(value);

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
      serverInfo: { name: "zircon-irc", title: "Zircon IRC", version },
      instructions: "Start with see_account_information. Reuse its sessionId in this chat for read_history(mode=unread) and ack_messages; separate agent sessions have separate unread cursors. read_history(mode=recent or last_hour) and search_history leave unread state alone. IRC presence is shared by all agents using this human account, so go_offline affects them all. Staying online records history and delivers subscribed mention events. Mention subscriptions are MCP Events methods invoked by a supported ChatGPT host, not ordinary tools. A public send_message needs user authorization unless automatic replies in this chat and channel were already authorized.",
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
      let failureReason = "challenge_failed";
      try { verified = await events.verify(delivery.url, delivery.secret, id); }
      catch (cause) {
        console.error("Event callback verification failed:", cause.message);
        failureReason = cause instanceof TypeError ? "internal_error" :
          /timeout/i.test(cause.message) ? "timeout" : "network_error";
      }
      if (!verified) {
        store.recordDiagnostic(user, "event", "verification_failed", failureReason);
        return rpc(call.id, { error: { code: -32015, message: "Callback verification failed",
          data: { reason: failureReason } } });
      }
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
    if (name === "see_account_information") {
      if (Object.keys(args).some(key => key !== "session_id") ||
          (args.session_id !== undefined && !validSessionId(args.session_id))) return error(call.id, -32602, "Invalid agent session");
      if (!args.session_id && !store.allowRate(`agent-session:${user.id}:${readPrincipal.clientId}`, 20, 60_000)) {
        return error(call.id, -32000, "Agent session rate limit reached");
      }
      let session;
      try { session = store.startAgentSession(user, readPrincipal.clientId, args.session_id); }
      catch (cause) {
        if (cause instanceof RangeError) return error(call.id, -32000, "Agent session limit reached");
        throw cause;
      }
      if (!session) return error(call.id, -32602, "Unknown agent session");
      let upstreamConnected = null;
      if (!user.online) upstreamConnected = false;
      else try { upstreamConnected = await pool.provisioner?.networkStatus?.(user) ?? null; }
      catch (cause) { console.error("Could not query ZNC upstream status:", cause.message); }
      const capture = store.captureStatus(user);
      const client = pool.clients?.get(user.id);
      const selected = JSON.parse(user.selected_channels);
      const enabled = new Set(selected.map(channel => channel.toLowerCase()));
      const zncSession = pool.connectionState?.(user) ?? (user.online ? "connecting" : "offline");
      const onlineSince = user.online && zncSession === "connected" && capture.lastAuthenticatedAt &&
        (!capture.lastDisconnectAt || capture.lastAuthenticatedAt > capture.lastDisconnectAt)
        ? capture.lastAuthenticatedAt : null;
      const network = config.ircNetworks.find(item => item.name === user.network_name);
      return toolResult(call.id, { version, ...session, githubLogin: user.github_login,
        displayName: user.display_name, network: user.network_name,
        server: network ? `${network.host}:${network.port}` : "unknown", nick: user.nick,
        settingsUrl: new URL("/settings", config.publicBaseUrl).href,
        online: Boolean(user.online), zncSession, upstreamConnected,
        joinedChannels: [...(client?.joined ?? [])].filter(channel => enabled.has(channel.toLowerCase())),
        onlineSince, lastDisconnectedAt: capture.lastDisconnectAt, lastReceived: capture.lastReceived,
        channels: store.mailboxStatus(user, session.sessionId),
        mentionEvents: summarizeEventState(store.clientEventStatus(user, readPrincipal.clientId)) });
    }
    if (name === "read_history") {
      const channels = JSON.parse(user.selected_channels);
      const channel = typeof args.channel === "string" ? channels.find(item => item.toLowerCase() === args.channel.toLowerCase()) : null;
      const limit = args.limit ?? 50;
      if (!channel || !["unread", "recent", "last_hour"].includes(args.mode) ||
          !Number.isInteger(limit) || limit < 1 || limit > 200 ||
          Object.keys(args).some(key => !["channel", "mode", "limit", "before", "session_id"].includes(key)) ||
          (args.session_id !== undefined && !validSessionId(args.session_id)) ||
          (args.mode === "unread" && (args.before !== undefined || !args.session_id)) ||
          (args.before !== undefined && typeof args.before !== "string")) {
        return error(call.id, -32602, "Invalid channel, mode, session, or limit");
      }
      if (args.session_id && !store.hasAgentSession(user, readPrincipal.clientId, args.session_id)) {
        return error(call.id, -32602, "Unknown agent session");
      }
      if (args.mode === "unread") {
        const unread = store.readUnread(user, args.session_id, channel, limit);
        return toolResult(call.id, { network: user.network_name, channel, mode: "unread",
          ...unread, nextBefore: null });
      }
      const since = args.mode === "last_hour" ? new Date(Date.now() - 3_600_000).toISOString() : null;
      const history = store.getHistory(user, channel, args.before, limit, since);
      if (!history) return error(call.id, -32602, "Invalid history cursor");
      return toolResult(call.id, { network: user.network_name, channel, mode: args.mode,
        ...history, batchId: null, hasMore: history.nextBefore !== null });
    }
    if (name === "ack_messages") {
      if (!validSessionId(args.session_id) || !store.hasAgentSession(user, readPrincipal.clientId, args.session_id) ||
          typeof args.batch_id !== "string" || !/^batch_[A-Za-z0-9_-]{32,64}$/.test(args.batch_id) ||
          Object.keys(args).some(key => !["session_id", "batch_id"].includes(key))) {
        return error(call.id, -32602, "Invalid agent session or batch ID");
      }
      if (!store.ackMessages(user, args.session_id, args.batch_id)) return error(call.id, -32602, "Unknown batch");
      return toolResult(call.id, { acknowledged: true });
    }
    if (name === "get_message_status") {
      if (typeof args.message_id !== "string" || !/^msg_[A-Za-z0-9_-]{24}$/.test(args.message_id) ||
          Object.keys(args).some(key => key !== "message_id")) return error(call.id, -32602, "Invalid message ID");
      const status = store.postStatus(user, args.message_id);
      if (!status) return error(call.id, -32602, "Unknown message ID");
      return toolResult(call.id, status);
    }
    if (name === "search_history") {
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
      store.recordOutgoing(user, key, channel, message);
      store.auditPost(user, channel, message);
      return toolResult(call.id, { status: "queued", network: user.network_name, channel, messageId });
    }
    if (name === "go_online" || name === "go_offline") {
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
