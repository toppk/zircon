const object = properties => ({ type: "object", properties, additionalProperties: false });
const string = { type: "string" };
const entry = { ...object({ network: string, channel: string, kind: string,
  time: string, observedAt: string, timestampSource: { type: "string", enum: ["server", "observed", "local"] },
  nick: string, text: string, target: { type: ["string", "null"] } }),
  required: ["network", "channel", "kind", "time", "observedAt", "timestampSource", "nick", "text", "target"] };
const publicEntry = ({ id, ...activity }) => activity;
const tools = [
  {
    name: "list_channels", title: "List IRC channels",
    description: "List the IRC network and channels this signed-in user has enabled in Zircon settings. Use this before reading a channel.",
    inputSchema: object({}),
    outputSchema: { ...object({ network: string, channels: { type: "array", items: string }, online: { type: "boolean" } }), required: ["network", "channels", "online"] },
    securitySchemes: [{ type: "oauth2", scopes: ["irc:read"] }],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "get_channel_messages", title: "Read IRC channel messages",
    description: "Read timestamped IRC messages and channel activity retained for this user. Channel names include the leading #. Each entry identifies its network, nick, kind, event time, and whether the time came from IRC server-time or local observation.",
    inputSchema: { ...object({ channel: string, limit: { type: "integer", minimum: 1, maximum: 200 } }), required: ["channel"] },
    outputSchema: { ...object({ channel: string, network: string, activity: { type: "array", items: entry },
      messages: { type: "array", items: entry } }), required: ["channel", "network", "activity", "messages"] },
    securitySchemes: [{ type: "oauth2", scopes: ["irc:read"] }],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "search_messages", title: "Search IRC messages",
    description: "Search retained messages in this user's enabled channels. Optional UTC since and until timestamps narrow the period, such as yesterday.",
    inputSchema: { ...object({ query: { type: "string", minLength: 1, maxLength: 100 }, channel: string,
      since: { type: "string", format: "date-time" }, until: { type: "string", format: "date-time" },
      limit: { type: "integer", minimum: 1, maximum: 100 } }), required: ["query"] },
    outputSchema: { ...object({ messages: { type: "array", items: entry } }), required: ["messages"] },
    securitySchemes: [{ type: "oauth2", scopes: ["irc:read"] }],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "get_mentions", title: "Get IRC mentions",
    description: "Return new retained channel messages mentioning this user's current IRC nick since the last check, then mark those mentions as seen.",
    inputSchema: object({ limit: { type: "integer", minimum: 1, maximum: 100 } }),
    outputSchema: { ...object({ mentions: { type: "array", items: entry } }), required: ["mentions"] },
    securitySchemes: [{ type: "oauth2", scopes: ["irc:read"] }],
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "send_message", title: "Send an IRC channel message",
    description: "Post one message to an enabled IRC channel under this user's nick. This is a public write action: confirm the exact channel and text with the user before calling. A successful result means queued to ZNC, never confirmed delivered. Reuse the same idempotency_key on retries.",
    inputSchema: { ...object({ channel: string, text: { type: "string", minLength: 1, maxLength: 400 },
      idempotency_key: { type: "string", minLength: 8, maxLength: 128 } }), required: ["channel", "text", "idempotency_key"] },
    outputSchema: { ...object({ status: { type: "string", enum: ["queued", "pending"] }, network: string,
      channel: string }), required: ["status", "network", "channel"] },
    securitySchemes: [{ type: "oauth2", scopes: ["irc:write"] }],
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  ...[false, true].map(online => ({
    name: online ? "go_online" : "go_offline", title: online ? "Go online on IRC" : "Go offline on IRC",
    description: online
      ? "Reconnect this user's approved IRC network. Staying online lets Zircon record new channel activity and, when enabled, deliver mention events."
      : "Disconnect this user's upstream IRC network and stop receiving new activity or events. Retained history stays readable. Use only when the user wants to pause their IRC presence.",
    inputSchema: object({}),
    outputSchema: { ...object({ online: { type: "boolean" }, network: string }), required: ["online", "network"] },
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

export function createMcpHandler(config, store, pool) {
  const challenge = scope => `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource", scope="${scope}"`;
  return async request => {
    const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const readUser = store.accessUser(bearer, "irc:read", config.publicBaseUrl);
    const writeUser = store.accessUser(bearer, "irc:write", config.publicBaseUrl);
    const user = readUser ?? writeUser;
    if (!user) return response({ error: "Unauthorized" }, 401, { "WWW-Authenticate": challenge("irc:read") });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    let call;
    try { call = await request.json(); } catch { return error(null, -32700, "Invalid JSON"); }
    if (!call || typeof call !== "object" || Array.isArray(call) || call.jsonrpc !== "2.0" || typeof call.method !== "string") {
      return error(null, -32600, "Invalid request");
    }
    if (call.id === undefined) return new Response(null, { status: 202 });
    if (call.method === "initialize") return result(call.id, {
      protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "zircon-irc", title: "Zircon IRC", version: "0.4.1" },
      instructions: "Use list_channels to see enabled channels and online status. Retained messages include IRC activity and timestamps. Staying online records new activity; going offline stops collection and future events. Sending an IRC message is public and irreversible, so confirm its destination and exact text with the user.",
    });
    if (call.method === "ping") return result(call.id, {});
    if (call.method === "tools/list") return result(call.id, { tools });
    if (call.method !== "tools/call") return error(call.id, -32601, "Method not found");
    const name = call.params?.name;
    const args = call.params?.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) return error(call.id, -32602, "Invalid arguments");
    const writeTool = ["go_online", "go_offline", "send_message"].includes(name);
    if (!(writeTool ? writeUser : readUser)) return response({ error: "Unauthorized" }, 401, { "WWW-Authenticate": challenge(writeTool ? "irc:write" : "irc:read") });
    if (name === "list_channels") {
      if (Object.keys(args).length) return error(call.id, -32602, "Invalid arguments");
      return toolResult(call.id, { network: user.network_name, channels: JSON.parse(user.selected_channels), online: Boolean(user.online) });
    }
    if (name === "get_channel_messages") {
      const channels = JSON.parse(user.selected_channels);
      const channel = typeof args.channel === "string" ? channels.find(item => item.toLowerCase() === args.channel.toLowerCase()) : null;
      const limit = args.limit ?? 50;
      if (!channel || !Number.isInteger(limit) || limit < 1 || limit > 200 || Object.keys(args).some(key => !["channel", "limit"].includes(key))) {
        return error(call.id, -32602, "Unknown channel or invalid limit");
      }
      const activity = store.recentActivity(user, channel, limit).map(publicEntry);
      return toolResult(call.id, { network: user.network_name, channel, activity, messages: activity.filter(item => ["message", "action"].includes(item.kind)) });
    }
    if (name === "search_messages") {
      const channels = JSON.parse(user.selected_channels);
      const channel = typeof args.channel === "string" ? channels.find(item => item.toLowerCase() === args.channel.toLowerCase()) : null;
      const validTime = value => value === undefined || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
      const limit = args.limit ?? 50;
      if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 100 ||
          (args.channel !== undefined && !channel) || !validTime(args.since) || !validTime(args.until) ||
          !Number.isInteger(limit) || limit < 1 || limit > 100 ||
          Object.keys(args).some(key => !["query", "channel", "since", "until", "limit"].includes(key))) {
        return error(call.id, -32602, "Invalid search arguments");
      }
      return toolResult(call.id, { messages: store.searchActivity(user, channel ? [channel] : channels,
        args.query.trim(), args.since ? new Date(args.since).toISOString() : null,
        args.until ? new Date(args.until).toISOString() : null, limit).map(publicEntry) });
    }
    if (name === "get_mentions") {
      const limit = args.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || Object.keys(args).some(key => key !== "limit")) {
        return error(call.id, -32602, "Invalid limit");
      }
      return toolResult(call.id, { mentions: store.getMentions(user, JSON.parse(user.selected_channels), limit).map(publicEntry) });
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
      if (reservation !== "new") return toolResult(call.id, { status: reservation, network: user.network_name, channel });
      if (!store.allowRate(`post:${user.id}`, 20, 60_000) || !store.allowRate(`post:network:${user.network_name}`, 60, 60_000)) {
        store.cancelPost(user, key);
        return error(call.id, -32000, "Message rate limit reached");
      }
      try {
        const irc = await pool.forUser(user);
        irc.sendMessage(channel, message);
      } catch (cause) {
        store.cancelPost(user, key);
        console.error("MCP IRC post failed:", cause.message);
        return error(call.id, -32603, "IRC channel unavailable");
      }
      store.completePost(user, key);
      store.auditPost(user, channel, message);
      const time = new Date().toISOString();
      store.recordActivity(user, { channel, kind: "message", time, observedAt: time,
        timestampSource: "local", nick: user.nick, text: message });
      return toolResult(call.id, { status: "queued", network: user.network_name, channel });
    }
    if (writeTool) {
      if (Object.keys(args).length) return error(call.id, -32602, "Invalid arguments");
      try { await pool.setOnline(user, name === "go_online"); }
      catch (cause) { console.error("MCP IRC presence change failed:", cause.message); return error(call.id, -32603, "IRC presence change unavailable"); }
      return toolResult(call.id, { online: name === "go_online", network: user.network_name });
    }
    return error(call.id, -32601, "Unknown tool");
  };
}
