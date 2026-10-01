---
title: API reference
eyebrow: Use
lede: Zircon's HTTP surface, covering the GPT Action schema, OAuth, the IRC endpoints and the owner's invite call.
description: Zircon HTTP endpoints, OAuth flow, IRC API and admin invite.
---

## Discovery

`GET /openapi.json`
: The OpenAPI 3.1 schema to import into the GPT Action builder.

`GET /healthz`
: `{"ok": true}` when the service is up.

`GET /privacy`
: The privacy page to use as the Action's privacy URL.

## OAuth

Zircon is the authorization server for the GPT Action. It supports the
authorization code grant with an optional S256 PKCE challenge, and refresh
tokens. The client is confidential: the token and revoke endpoints always
require the client ID and secret, in the form body or with HTTP Basic.

| endpoint | purpose |
|---|---|
| `GET /oauth/authorize` | starts sign-in; `response_type=code`, `client_id`, exact `redirect_uri`, `state`, `scope` |
| `POST /oauth/token` | `grant_type=authorization_code` or `refresh_token` |
| `POST /oauth/revoke` | revokes an access or refresh token |

Scopes are `irc:read` and `irc:write`. Refresh tokens rotate on each use.
Redirect URIs must exactly match one in `oauthRedirectUris`, and must be a
ChatGPT GPT Action callback.

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
