const object = properties => ({ type: "object", properties, additionalProperties: false });
const string = { type: "string" };
const nullableString = { type: ["string", "null"] };
const read = [{ type: "oauth2", scopes: ["irc:read"] }];
const write = [{ type: "oauth2", scopes: ["irc:write"] }];

export const activityEntry = { ...object({ entryId: string, messageId: nullableString,
  network: string, channel: string, kind: string, time: string, observedAt: string,
  timestampSource: { type: "string", enum: ["server", "observed", "local"] },
  nick: string, text: string, target: nullableString, mention: { type: "boolean" } }),
  required: ["entryId", "messageId", "network", "channel", "kind", "time", "observedAt", "timestampSource", "nick", "text", "target", "mention"] };
const lastActivity = { ...object({ entryId: string, kind: string, channel: string, observedAt: string }),
  required: ["entryId", "kind", "channel", "observedAt"] };
const lastAcknowledged = { ...object({ entryId: string, kind: string, time: string, observedAt: string }),
  required: ["entryId", "kind", "time", "observedAt"] };
const channelState = { ...object({ channel: string, unreadCount: { type: "integer" },
  lastAcknowledged: { anyOf: [lastAcknowledged, { type: "null" }] }, pendingBatchId: nullableString }),
  required: ["channel", "unreadCount", "lastAcknowledged", "pendingBatchId"] };
const mentionState = { ...object({ scope: { type: "string", enum: ["oauth_client"] },
  state: { type: "string", enum: ["not_subscribed", "subscribed_idle", "delivery_pending", "delivery_accepted", "delivery_failed"] },
  activeSubscriptions: { type: "integer" }, pendingDeliveries: { type: "integer" },
  lastDeliveryAttemptAt: nullableString, lastDeliveryStatus: nullableString, nextStep: string }),
  required: ["scope", "state", "activeSubscriptions", "pendingDeliveries", "lastDeliveryAttemptAt", "lastDeliveryStatus", "nextStep"] };

export const tools = [
  {
    name: "see_account_information", title: "See my IRC account and session",
    description: "Start here. Show the configured IRC server, nick and channels, connection and online duration, last captured activity, this agent's unread counts and last acknowledged entries, and mention subscriptions for this OAuth client. On the first call omit session_id to create an independent agent mailbox; reuse the returned sessionId in this chat. Settings can be changed at settingsUrl. IRC presence is shared by all agents using this human account.",
    inputSchema: object({ session_id: string }),
    outputSchema: { ...object({ version: string, sessionId: string, sessionCreatedAt: string,
      githubLogin: string, displayName: string, network: string, server: string, nick: string, settingsUrl: string,
      online: { type: "boolean" }, zncSession: { type: "string", enum: ["offline", "connecting", "connected"] },
      upstreamConnected: { type: ["boolean", "null"] }, joinedChannels: { type: "array", items: string },
      onlineSince: nullableString, lastDisconnectedAt: nullableString,
      lastReceived: { anyOf: [lastActivity, { type: "null" }] },
      channels: { type: "array", items: channelState }, mentionEvents: mentionState }),
      required: ["version", "sessionId", "sessionCreatedAt", "githubLogin", "displayName", "network", "server", "nick", "settingsUrl",
        "online", "zncSession", "upstreamConnected", "joinedChannels", "onlineSince", "lastDisconnectedAt",
        "lastReceived", "channels", "mentionEvents"] },
    securitySchemes: read,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "go_online", title: "Connect my IRC account",
    description: "Connect this human account's ZNC network and establish Zircon's ZNC session. This affects every agent using the account. The result may be connecting; use see_account_information to confirm upstream connection and channel joins. Staying online lets Zircon store history and deliver subscribed mention events.",
    inputSchema: object({}),
    outputSchema: { ...object({ online: { type: "boolean" }, network: string,
      connection: { type: "string", enum: ["offline", "connecting", "connected"] } }),
      required: ["online", "network", "connection"] },
    securitySchemes: write,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "read_history", title: "Read IRC history",
    description: "Read one enabled channel. mode=recent returns the newest retained activity in one call; mode=last_hour returns activity whose IRC timestamp is within the last hour; mode=unread returns this agent session's next stable unacknowledged batch, oldest arrival first. Supply session_id for unread. A pending batch can be shorter than a newly requested limit. Only unread batches require ack_messages. Pass nextBefore as before to page recent or last_hour results.",
    inputSchema: { ...object({ channel: string, mode: { type: "string", enum: ["unread", "recent", "last_hour"] },
      session_id: string, before: string, limit: { type: "integer", minimum: 1, maximum: 200 } }),
      required: ["channel", "mode"] },
    outputSchema: { ...object({ network: string, channel: string,
      mode: { type: "string", enum: ["unread", "recent", "last_hour"] },
      entries: { type: "array", items: activityEntry }, batchId: nullableString,
      nextBefore: nullableString, hasMore: { type: "boolean" } }),
      required: ["network", "channel", "mode", "entries", "batchId", "nextBefore", "hasMore"] },
    securitySchemes: read,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "ack_messages", title: "Acknowledge processed IRC activity",
    description: "After processing a read_history(mode=unread) batch, acknowledge its batchId in the same agent session. Other sessions' cursors are unaffected. Repeating the same acknowledgement is safe.",
    inputSchema: { ...object({ session_id: string, batch_id: string }), required: ["session_id", "batch_id"] },
    outputSchema: { ...object({ acknowledged: { type: "boolean" } }), required: ["acknowledged"] },
    securitySchemes: read,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "search_history", title: "Search retained IRC messages",
    description: "Search this user's enabled channels using a case-insensitive exact phrase. Results are newest first. Optional UTC since and until narrow the period; pass nextBefore as before to continue. Search does not change any agent's unread state.",
    inputSchema: { ...object({ query: { type: "string", minLength: 1, maxLength: 100 }, channel: string,
      since: { type: "string", format: "date-time" }, until: { type: "string", format: "date-time" },
      before: string, limit: { type: "integer", minimum: 1, maximum: 100 } }), required: ["query"] },
    outputSchema: { ...object({ messages: { type: "array", items: activityEntry }, nextBefore: nullableString }),
      required: ["messages", "nextBefore"] },
    securitySchemes: read,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "send_message", title: "Send an IRC channel message",
    description: "Post one message to an enabled IRC channel under this human account's nick. This is public and irreversible: confirm the channel and text unless the user authorized automatic replies here. A successful result means queued to ZNC, not confirmed delivered. Reuse idempotency_key on retries; messageId stays stable.",
    inputSchema: { ...object({ channel: string, text: { type: "string", minLength: 1, maxLength: 400 },
      idempotency_key: { type: "string", minLength: 8, maxLength: 128 } }), required: ["channel", "text", "idempotency_key"] },
    outputSchema: { ...object({ status: { type: "string", enum: ["queued", "pending", "echoed"] },
      network: string, channel: string, messageId: string }), required: ["status", "network", "channel", "messageId"] },
    securitySchemes: write,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "get_message_status", title: "Check an outgoing message",
    description: "Check one send_message result. queued means written to the local ZNC socket; echoed means Zircon later observed a matching line through ZNC. Neither proves another person read it. Failed requests can be retried with the original idempotency key.",
    inputSchema: { ...object({ message_id: string }), required: ["message_id"] },
    outputSchema: { ...object({ messageId: string, network: string, channel: string,
      status: { type: "string", enum: ["pending", "queued", "echoed", "failed"] },
      createdAt: string, echoedAt: nullableString, entryId: nullableString, failureReason: nullableString }),
      required: ["messageId", "network", "channel", "status", "createdAt", "echoedAt", "entryId", "failureReason"] },
    securitySchemes: read,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "go_offline", title: "Disconnect my IRC account",
    description: "Disconnect this human account from the upstream IRC network and close Zircon's local ZNC session. This affects every agent using the account, stops new history capture and mention events, and keeps retained history readable. Use only when the user explicitly wants the account offline.",
    inputSchema: object({}),
    outputSchema: { ...object({ online: { type: "boolean" }, network: string,
      connection: { type: "string", enum: ["offline", "connecting", "connected"] } }),
      required: ["online", "network", "connection"] },
    securitySchemes: write,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
];

export function summarizeEventState(event) {
  const accepted = /^2\d\d$/.test(event.lastEventDeliveryStatus ?? "");
  const state = event.eventSubscriptionCount === 0 ? "not_subscribed" :
    event.pendingDeliveries > 0 ? "delivery_pending" :
      !event.lastEventAttemptAt ? "subscribed_idle" : accepted ? "delivery_accepted" : "delivery_failed";
  const nextStep = {
    not_subscribed: "No push delivery is active. In a supported ChatGPT Work chat, ask ChatGPT to monitor message.mention. ChatGPT must call MCP events/subscribe; ordinary Zircon tools cannot subscribe for it.",
    subscribed_idle: "At least one subscription exists for this OAuth client; this chat may not own it. Send a matching message in the subscribed chat and inspect account information again.",
    delivery_pending: "A matching event is queued for the background worker.",
    delivery_accepted: "The receiver accepted the last callback. ChatGPT processes events asynchronously; acceptance does not prove a chat response.",
    delivery_failed: "The last callback was not accepted. Check owner diagnostics and receiver availability.",
  }[state];
  return { scope: "oauth_client", state, activeSubscriptions: event.eventSubscriptionCount,
    pendingDeliveries: event.pendingDeliveries, lastDeliveryAttemptAt: event.lastEventAttemptAt,
    lastDeliveryStatus: event.lastEventDeliveryStatus, nextStep };
}
