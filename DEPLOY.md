# Zircon deployment requirements

Zircon uses one ZNC process with a separate ZNC account and IRC network per invited GitHub user. It creates and updates them through ZNC's `controlpanel` IRC module and persists changes with `*status SaveConfig`. User changes do **not** restart ZNC or start another ZNC process. The ne2 ZNC migration is complete. The MCP read connector is ready for a ChatGPT developer-mode test; public onboarding and directory submission are still pending.

```yaml
app: zircon
hostname: zircon.chooser.us
listen_address: 127.0.0.1
listen_port: 3000
health_path: /healthz
websockets: no
mcp_transport: Streamable HTTP, JSON response mode at /mcp
max_request_body: 4k
state:
  path: /var/lib/zircon
  contents: SQLite users, GitHub identities, sessions, registered OAuth clients, hashed OAuth tokens, settings and post audit
  backup: yes
secrets:
  file: /var/lib/zircon-secrets/zircon.env
  names: [GITHUB_CLIENT_SECRET, OAUTH_CLIENT_SECRET, SESSION_SECRET, ADMIN_TOKEN, ZNC_ADMIN_PASSWORD, ZNC_USER_SECRET]
outbound_network:
  - github.com:443 (GitHub sign-in token exchange)
  - api.github.com:443 (GitHub identity lookup)
  - 127.0.0.1:6667 (ZNC administration and per-user IRC clients)
  - irc.chonkbase.net:6697 (ZNC upstream over verified TLS)
memory_estimate: Bun observed around 55 MB resident on ne2 before active user load; reserve 128 MB for Bun, and measure ZNC and Bun per active user before raising the 16-user cap
scheduled_jobs: none
public_irc_client_port: no
znc_web_admin_public: no
```

## One-time ZNC migration on ne2

The deployed ZNC module has `services.znc.mutable = false`. In the pinned nixpkgs module, that mode deletes and recreates `znc.conf` on service start, so dynamically added users would disappear after a rebuild. Change it to `mutable = true` **after** seeding a dedicated administrator account with the `controlpanel` user module. Keep the existing loopback-only `Listener` override; the NixOS ZNC module otherwise provides a public `:5000` listener by default. No ZNC web admin or public IRC client port is needed.

Seed the `zirconctl` account with `Admin = true`, `LoadModule = [ "controlpanel" ]`, and a salted password hash in Nix configuration. Generate the password on ne2, place its value only in `/var/lib/zircon-secrets/zircon.env` as `ZNC_ADMIN_PASSWORD`, and put only its salted hash in Nix. Set `ZNC_ADMIN_USER=zirconctl` through the Zircon module's public setting. The existing `zircon` account and its `ZNC_PASSWORD` may remain for the old buffer, but Zircon no longer uses that shared identity. As the current ZNC is already running with `mutable = false`, apply the admin account in one system-managed configuration first, then enable `mutable = true` and verify that a ZNC restart no longer removes dynamically created accounts. This is a one-time migration, not a per-user restart.

Zircon derives each user's ZNC password using HMAC-SHA256 from the host-only `ZNC_USER_SECRET` and the stable Zircon user ID. Never rotate that secret without a migration: old ZNC account passwords would no longer match. ZNC stores the accounts and upstream buffers under `/var/lib/znc`, so add that directory to backups too. Zircon's own database is in `/var/lib/zircon` and must also be backed up. Zircon writes a verified, consistent SQLite copy to `/var/lib/zircon/backup/zircon.sqlite` on startup and every 24 hours for live-disk snapshot services. Restore both ZNC and Zircon state from the same backup point; if the raw SQLite files are inconsistent, use the copy.

## Zircon configuration

The NixOS module `services.zircon` uses `DynamicUser`, a private state directory, hardened systemd settings, stdout logging, and an environment file outside the Nix store. Supply `environmentFile = "/var/lib/zircon-secrets/zircon.env"`. Put these **names** in that file: `GITHUB_CLIENT_SECRET`, `OAUTH_CLIENT_SECRET`, `SESSION_SECRET`, `ADMIN_TOKEN`, `ZNC_ADMIN_PASSWORD`, `ZNC_USER_SECRET`. GitHub issues `GITHUB_CLIENT_SECRET`; generate the others on ne2. The old `ZNC_PASSWORD` may stay there for the existing ZNC account; Zircon does not read it.

Set `settings.githubClientId` to the ID of a GitHub OAuth app with callback `https://zircon.chooser.us/login/github/callback`. GitHub handles sign-in; Zircon is the OAuth authorization server for the MCP connector. `settings.oauthRedirectUris` is optional and now only serves the legacy GPT Action client. Add owner-approved IRC servers to `settings.ircNetworks`; it defaults to `chonkbase` at `irc.chonkbase.net:6697` with TLS. Users choose among that list and set their own nick at `/settings`. `settings.ircChannels` defines channels the owner can grant in invitations, initially `#soup`. The module caps users at 16 by default because ne2 has 1 GB total RAM shared with other services.

Example:

```nix
services.zircon = {
  enable = true;
  environmentFile = "/var/lib/zircon-secrets/zircon.env";
  settings = {
    githubClientId = "<GitHub OAuth app client ID>";
    zncAdminUser = "zirconctl";
    ircChannels = [ "#soup" ];
  };
};
```

## ChatGPT connector milestone

Configure a custom MCP connection in ChatGPT developer mode with server URL `https://zircon.chooser.us/mcp`. Zircon answers unauthorized requests with a `WWW-Authenticate` link to `/.well-known/oauth-protected-resource`; OAuth server metadata is at `/.well-known/oauth-authorization-server`. ChatGPT can register at `/oauth/register` using its exact callback URL. Zircon accepts the documented `https://chatgpt.com/connector/oauth/{callback_id}` and `https://chatgpt.com/connector_platform_oauth_redirect` forms, and stores the exact URI per client. Registered clients must use S256 PKCE and `resource=https://zircon.chooser.us` throughout authorization and token exchange. Access tokens are opaque, hashed at rest, and bound to the resource. The first two tools are `list_channels` and `get_channel_messages`; both require `irc:read`.

The authorization server does **not** advertise RFC 9207 issuer identification, so ChatGPT should use a callback-ID-specific redirect URI as described in [OpenAI's MCP authentication guide](https://developers.openai.com/plugins/build/auth). If ChatGPT shows a different callback, inspect it before changing the server's allowlist. The legacy GPT Action endpoints and optional callback list remain for compatibility; they do not determine MCP redirects.

Before testing on ne2, update the infra flake pin to a commit containing `/mcp`. The read tools return JSON directly, so this milestone does not need a long-lived stream, though HAProxy's 25-second timeout should be raised before any future streaming response. A local automated test covers registration, consent, PKCE, resource-bound tokens and tool calls. An actual ChatGPT developer-mode connection still needs an owner test.

[OpenAI's migration guide](https://learn.chatgpt.com/docs/migrate-custom-gpts) says custom GPT Actions do not transfer to plugins. Its detailed retirement guidance is for Enterprise workspaces; availability for other plans must be checked for the owner. The [public plugin submission guide](https://developers.openai.com/plugins/deploy/submission) describes a universal directory shared by ChatGPT and Codex, but publication requires an approved plugin package and verified developer identity.

## How a new user joins

1. The owner invites a GitHub username with `POST /admin/invite`, authenticated by `ADMIN_TOKEN`, and assigns allowed channels such as `#soup`.
2. The owner sends the user the private MCP connection. The user connects it, signs in with GitHub, and consents to IRC read access. Zircon binds their GitHub numeric ID on first sign-in.
3. The user visits `/settings` to select an approved IRC server, their own nickname, display name, and channels from the owner's invitation. Zircon updates their separate ZNC account through `controlpanel` and saves ZNC's configuration.
4. When ChatGPT calls a read tool, Zircon attaches to that user's ZNC account. The user's channel buffer is isolated from other users. MCP posting is not exposed yet.

## Work before public directory submission

- Persist channel history with bounded retention and per-user visibility; add search and mentions. Current read tools see only the live per-user ZNC replay buffer. Storage per channel per day is not measurable until retention and ingestion are implemented.
- Add MCP Events after history, keeping read tools independent. [OpenAI's Events guide](https://developers.openai.com/plugins/build/mcp-events) requires MCP 2.0 (`2026-07-28`), `server/discover`, and `events/list`, `events/subscribe`, `events/unsubscribe` on `/mcp`. Start with `message.mention`, then `message.channel`, with network/channel/sender/keyword filters enforced before delivery. Persist subscriptions with TTL and per-user channel access; expose them in `/settings` for revocation.
- Verify each HTTPS webhook callback before activation. Re-resolve destinations at connection time and reject non-public addresses and redirects. Require a valid `whsec_` secret and Standard Webhooks signatures. Deliver one event per request from a bounded background queue, retry transient failures with a stable event ID and fresh signature, and stop on 410/413. Suppress Zircon's own messages and rate-limit each subscription to prevent IRC bot loops. The planned queue cap is 32 payloads of at most 256 KiB (8 MiB payload budget) with two concurrent deliveries; allow roughly 12 MiB extra resident memory for the worker until measured. Events send channel text to OpenAI, so disclose that in `/privacy` before enabling them. OpenAI currently limits Events to Work chats on web, Work chats on desktop with Cloud, and dots, subject to workspace controls; the tools must remain useful without Events.
- Add `send_message` with a write annotation, a queued acknowledgement, user confirmation and per-user/network rate limits. The current REST post endpoint is not advertised as an MCP tool.
- Replace invite-only onboarding with bounded self-service signup, owner-approved channel opt-in, abuse controls and per-user/per-network kill switches. Keep `MAX_USERS=16` on ne2 until memory and ZNC cost per active user are measured.
- Add self-service deletion, a documented retention policy, an updated privacy page, terms, support contact and reviewer test account. Current `/privacy` describes the current data only.
- Build the plugin ZIP and supply the verified developer identity, domain verification, listing assets, review test cases and credentials required by the [submission guide](https://developers.openai.com/plugins/deploy/submission) and [review requirements](https://developers.openai.com/plugins/deploy/app-review). Recheck both just before submission.

For a local protocol check against a temporary ZNC instance, run `bun tools/check-znc.js /path/to/znc`. It verifies account creation, TLS server and channel configuration, saved state, and client login without a restart.
