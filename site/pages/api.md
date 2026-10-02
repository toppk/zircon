---
title: API reference
eyebrow: Use
lede: Zircon's MCP connector, OAuth discovery and existing REST endpoints.
description: Zircon MCP tools, OAuth discovery, IRC API and admin invite.
---

## Discovery

`POST /mcp` or `POST /mcp/`
: Streamable HTTP MCP endpoint. It responds to JSON-RPC initialization, `server/discover`, tool and event methods with JSON. An unauthenticated request returns an OAuth discovery challenge.

`GET /.well-known/oauth-protected-resource`
: Resource metadata for the MCP connector.

`GET /.well-known/oauth-protected-resource/mcp`
: The same resource metadata at the path used when ChatGPT probes `/mcp/`.

`GET /.well-known/oauth-authorization-server`
: Authorization server metadata, including PKCE S256 and registration.

`POST /oauth/register`
: Dynamic client registration for exact ChatGPT connector callback URIs. Supports public and confidential clients.

`GET /openapi.json`
: Legacy GPT Action schema.

`GET /healthz`
: `{"ok": true}` when the service is up.

`GET /privacy`
: The privacy page to use as the Action's privacy URL.

`GET /admin/events`
: Optional owner diagnostics when enabled. Requires an allowlisted signed-in GitHub session or `Authorization: Bearer <ADMIN_TOKEN>`. Returns recent IRC activity and MCP/connection metadata; accepts `limit` (1–200) and ISO 8601 `since`.

## OAuth

Zircon is the authorization server for the MCP connector. Registered MCP clients must use the authorization code grant with S256 PKCE and include `resource=https://zircon.chooser.us` in authorization and token requests. Access tokens are bound to that resource. Refresh tokens rotate on each use. The legacy GPT Action client remains confidential and accepts optional PKCE for compatibility.

| endpoint | purpose |
|---|---|
| `GET /oauth/authorize` | starts sign-in; `response_type=code`, `client_id`, exact `redirect_uri`, `state`, `scope` |
| `POST /oauth/token` | `grant_type=authorization_code` or `refresh_token` |
| `POST /oauth/revoke` | revokes an access or refresh token |

Scopes are `irc:read` and `irc:write`. Refresh tokens rotate on each use.
Each dynamically registered redirect URI must exactly match one submitted at registration. The older GPT Action client uses the optional `oauthRedirectUris` list.

## MCP tools

| tool | scope | result |
|---|---|---|
| `see_account_information` | `irc:read` | Start or resume an agent session; see nick, server, channels, presence, last captured activity, unread and last acknowledged entries, and mention subscription state |
| `go_online` | `irc:write` | Connect this human account's ZNC network and establish Zircon's ZNC session for history capture and events |
| `read_history` | `irc:read` | Read `recent`, `last_hour` or `unread` activity in one channel; unread requires the agent's `session_id` |
| `ack_messages` | `irc:read` | Advance only the specified agent session's channel cursor after processing an unread batch |
| `search_history` | `irc:read` | Case-insensitive exact phrase search, newest first, with channel, UTC time and opaque pagination |
| `send_message` | `irc:write` | Queue one message to an enabled channel; returns a stable `messageId` for retries |
| `get_message_status` | `irc:read` | Inspect a queued send by `message_id`: pending, queued, echoed or failed |
| `go_offline` | `irc:write` | Disconnect this human account's upstream IRC network and local ZNC session, affecting all its agents |

One human account owns one ZNC network connection. Every agent using that account shares its nick, channels and online state. Calling `go_offline` therefore disconnects the account for all agents. Zircon retains history while offline but captures no new IRC activity or mention events. `see_account_information` reports the local ZNC session, upstream status, joined channels and `onlineSince`; `upstreamConnected: null` means the status query could not determine a state. The returned `settingsUrl` is where the human can change the approved network, nick and channels.

For independent unread processing, call `see_account_information` without `session_id` once per agent and retain its `sessionId` in that chat. Pass it as `session_id` to `read_history(mode=unread)` and `ack_messages`. Calling `see_account_information` with the existing ID resumes the same mailbox and shows each channel's unread count and last acknowledged entry. Agent sessions are bound to the signed-in user and OAuth client; one agent cannot acknowledge another session's batch. Sessions survive restarts and expire after 30 days of inactivity. A first call without an ID creates a new mailbox starting at the earliest retained activity, so an agent can recover by opening a new session if it loses its ID.

Activity includes messages, actions, joins, parts, kicks, topics and modes. Each retained entry has a stable `entryId`, network and channel context, the sender's nick, event time, observation time, and a timestamp source (`server`, `observed` or `local`). An entry linked to a Zircon send also has its `messageId`; other entries have `messageId: null`. `read_history(mode=unread)` marks entries that mention the current nick and returns the same batch until acknowledged. `recent` and `last_hour` return newest first and do not change unread state. `last_hour` uses the IRC event timestamp. Retention limits still apply to unacknowledged data.

`send_message` returns **queued** after writing to the local ZNC socket. Zircon records one local channel entry immediately and links its stable `entryId` to the outgoing `messageId`. If a matching ZNC echo or replay arrives, it updates that entry with the server timestamp and `get_message_status` reports **echoed**. An echo shows that the line came back through ZNC; it cannot prove that other people received or read it. If no echo arrives, the status stays **queued** and the entry's `timestampSource` stays **local**. A failed write can be retried with the same idempotency key. Old duplicate entries created before this change remain until normal retention pruning.

`lastReceived` identifies the newest captured entry in an enabled channel. ZNC's finite buffer means Zircon cannot certify complete capture across disconnects; compare `lastDisconnectedAt`, `onlineSince` and the retained entries when investigating a gap.

## MCP Events

Zircon advertises MCP 2.0 (`2026-07-28`) through `server/discover` and supports `events/list`, `events/subscribe` and `events/unsubscribe` at the authenticated `/mcp` endpoint. The first event is `message.mention`: a channel message containing the user's current nick as a whole token, case-insensitively. It has no alternate nick or alias matching. Subscription filters are `network`, `channel`, `sender` and `keyword`; all supplied filters must match. Omit `channel` to follow every channel the user enables now or later. A channel-specific subscription stays pinned to its original channel and pauses when that channel is disabled; it does not move to a new channel. A channel must be enabled when subscribing to it. An event includes network, channel, sender, text, kind, observation time and the retained `entryId`, which can be matched to history or unread results. IRC messages sent under the user's own nick do not emit events.

Subscriptions survive restarts. Zircon verifies the HTTPS callback before activation, signs each delivery using Standard Webhooks, and retries transient failures from a bounded background queue. New mentions wake the delivery worker immediately; a five-second poll covers retries and serves as a fallback. Each retry keeps its event ID and gets a new signature and timestamp; delivery order is not guaranteed. Replayed lines are processed if Zircon has not recorded the same fingerprint before, so a reconnect can produce a late mention event. Unread batches remain unacknowledged until the agent calls `ack_messages`; event delivery does not advance that cursor. Users can view and revoke subscriptions at `/settings`. `events/list` only advertises the event; ChatGPT must also call `events/subscribe` for callbacks to begin. Event delivery requires Zircon to stay online; ordinary tools work independently of Events. [OpenAI's Events guide](https://developers.openai.com/plugins/build/mcp-events) describes which ChatGPT surfaces can receive events.

`see_account_information.mentionEvents` reports `not_subscribed` until the calling OAuth client has an active subscription. It then distinguishes an idle subscription, a queued delivery, an accepted callback and a failed callback, and shows each subscription's filters, paused state and expiry. Event subscriptions are tied to the OAuth client and ChatGPT callback URL, independently of the agent's unread mailbox session. Zircon does not receive ChatGPT's callback URL from an ordinary tool; the ChatGPT event host must invoke the separate MCP `events/subscribe` method. To move a channel-specific subscription, ChatGPT unsubscribes with its original filters and callback URL, then subscribes with the new filters. Unsubscribe works even after the old channel is disabled. An accepted callback means ChatGPT received the webhook, while its chat response happens later. The account result omits callback URLs, secrets and tokens.

## IRC endpoints

Send `Authorization: Bearer <access token>`. Channel names in the path
omit the leading `#` and match case-insensitively against the user's
enabled channels.

### `GET /v1/status`

Scope `irc:read`. The user's ZNC connection and channels.

```json
{ "connected": true, "joined_channels": ["#soup"], "enabled_channels": ["#soup"] }
```

### `GET /v1/channels/{channel}/messages`

Scope `irc:read`. Recent retained activity; `limit` is 1 to 200, default 50.

```sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://zircon.chooser.us/v1/channels/soup/messages?limit=20"
```

### `POST /v1/channels/{channel}/messages`

Scope `irc:write`. Sends one line, 1 to 400 characters, no control
characters. Returns `202` with `{"accepted": true, "channel": "#soup"}`.

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"hello"}' \
  https://zircon.chooser.us/v1/channels/soup/messages
```

### Errors

| status | meaning |
|---|---|
| 400 | bad channel name or `limit` |
| 401 | missing, expired or under-scoped token |
| 404 | channel not enabled for this user |
| 422 | message text is empty, too long, or not one line |
| 429 | more than 20 posts in a minute |
| 503 | ZNC is unreachable or the user's account could not be provisioned |

## Owner: invite a user

An owner whose GitHub login is listed in `settings.ownerLogins` can
sign in and use **People with access** on `/settings`. The panel lists invited
users, shows their granted and enabled channels, and has forms to invite people
or replace existing grants. No `ADMIN_TOKEN` is sent to the browser. Unchecking
all channels for an existing user removes IRC channel access without deleting
their account or stored history.

The token endpoint remains available for automation:

`POST /admin/invite` with `Authorization: Bearer <ADMIN_TOKEN>`:

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"github_login":"alice","channels":["#soup"]}' \
  https://zircon.chooser.us/admin/invite
```

`channels` must come from `ircChannels` and defaults to all of them.
A new user starts with no channels enabled and a nick derived from their GitHub
login (limited to 31 characters and prefixed with `u` if the login starts with
a digit). The user selects granted channels in `/settings`. Inviting an existing
user replaces their grants, keeps selections that are still allowed, and leaves
new grants off. Returns `201`, or `409` when the user limit is reached.

## Browser pages

`/login`, `/login/github/callback`, `/settings` and `POST /logout` are for
people, not the GPT. Consent and settings forms carry a CSRF token; session cookies are
`__Host-` prefixed, `Secure` and `HttpOnly`.
