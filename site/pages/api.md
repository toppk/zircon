---
title: API reference
eyebrow: Use
lede: Zircon's MCP connector, OAuth discovery and existing REST endpoints.
description: Zircon MCP tools, OAuth discovery, IRC API and admin invite.
---

## Discovery

`POST /mcp`
: Streamable HTTP MCP endpoint. It responds to JSON-RPC initialization, `tools/list` and `tools/call` with JSON. An unauthenticated request returns an OAuth discovery challenge.

`GET /.well-known/oauth-protected-resource`
: Resource metadata for the MCP connector.

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
| `list_channels` | `irc:read` | The user's chosen network and enabled channels |
| `get_channel_messages` | `irc:read` | Up to 200 recent buffered messages from one enabled channel |

Messages come from the current per-user ZNC replay buffer. Persistent history, search, mentions and posting through MCP are planned before public directory submission.

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

Scope `irc:read`. Recent messages; `limit` is 1 to 200, default 50.

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

`POST /admin/invite` with `Authorization: Bearer <ADMIN_TOKEN>`:

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"github_login":"alice","channels":["#soup"]}' \
  https://zircon.chooser.us/admin/invite
```

`channels` must come from `ircChannels` and defaults to all of them.
A new user starts with every granted channel enabled and a nick derived
from their GitHub login (limited to 31 characters and prefixed with `u` if
the login starts with a digit). Inviting an existing user replaces their granted channels
and enables all of them again. Returns `201`,
or `409` when the user limit is reached.

## Browser pages

`/login`, `/login/github/callback`, `/settings` and `POST /logout` are for
people, not the GPT. Consent and settings forms carry a CSRF token; session cookies are
`__Host-` prefixed, `Secure` and `HttpOnly`.
