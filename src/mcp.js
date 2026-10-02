const object = properties => ({ type: "object", properties, additionalProperties: false });
const string = { type: "string" };
const tools = [
  {
    name: "list_channels", title: "List IRC channels",
    description: "List the IRC network and channels this signed-in user has enabled in Zircon settings. Use this before reading a channel.",
    inputSchema: object({}),
    outputSchema: { ...object({ network: string, channels: { type: "array", items: string } }), required: ["network", "channels"] },
    securitySchemes: [{ type: "oauth2", scopes: ["irc:read"] }],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_channel_messages", title: "Read IRC channel messages",
    description: "Read recent messages from one channel enabled by this signed-in user. Channel names include the leading #. Results are currently limited to the live ZNC replay buffer, not a persistent archive.",
    inputSchema: { ...object({ channel: string, limit: { type: "integer", minimum: 1, maximum: 200 } }), required: ["channel"] },
    outputSchema: { ...object({ channel: string, messages: { type: "array", items: { ...object({ time: string, channel: string, nick: string, text: string }), required: ["time", "channel", "nick", "text"] } } }), required: ["channel", "messages"] },
    securitySchemes: [{ type: "oauth2", scopes: ["irc:read"] }],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
];

const response = (body, status = 200, headers = {}) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", ...headers },
});
const rpc = (id, value) => response({ jsonrpc: "2.0", id, ...value });
const error = (id, code, message) => rpc(id, { error: { code, message } });
const result = (id, data) => rpc(id, { result: data });
const toolResult = (id, data) => result(id, { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] });

export function createMcpHandler(config, store, pool) {
  const challenge = `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource", scope="irc:read"`;
  return async request => {
    const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const user = store.accessUser(bearer, "irc:read", config.publicBaseUrl);
    if (!user) return response({ error: "Unauthorized" }, 401, { "WWW-Authenticate": challenge });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    let call;
    try { call = await request.json(); } catch { return error(null, -32700, "Invalid JSON"); }
    if (!call || typeof call !== "object" || Array.isArray(call) || call.jsonrpc !== "2.0" || typeof call.method !== "string") {
      return error(null, -32600, "Invalid request");
    }
    if (call.id === undefined) return new Response(null, { status: 202 });
    if (call.method === "initialize") return result(call.id, {
      protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "zircon", version: "0.3.0" },
      instructions: "Use list_channels before reading. IRC messages are visible to other people on the network. Zircon currently returns recent buffered messages only.",
    });
    if (call.method === "ping") return result(call.id, {});
    if (call.method === "tools/list") return result(call.id, { tools });
    if (call.method !== "tools/call") return error(call.id, -32601, "Method not found");
    const name = call.params?.name;
    const args = call.params?.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) return error(call.id, -32602, "Invalid arguments");
    if (name === "list_channels") {
      if (Object.keys(args).length) return error(call.id, -32602, "Invalid arguments");
      return toolResult(call.id, { network: user.network_name, channels: JSON.parse(user.selected_channels) });
    }
    if (name === "get_channel_messages") {
      const channels = JSON.parse(user.selected_channels);
      const channel = channels.find(item => item.toLowerCase() === args.channel?.toLowerCase());
      const limit = args.limit ?? 50;
      if (!channel || !Number.isInteger(limit) || limit < 1 || limit > 200 || Object.keys(args).some(key => !["channel", "limit"].includes(key))) {
        return error(call.id, -32602, "Unknown channel or invalid limit");
      }
      let irc;
      try { irc = await pool.forUser(user); }
      catch (cause) { console.error("MCP IRC setup failed:", cause.message); return error(call.id, -32603, "IRC setup unavailable"); }
      return toolResult(call.id, { channel, messages: irc.messages(channel, limit) });
    }
    return error(call.id, -32601, "Unknown tool");
  };
}
