# Zircon deployment requirements

Zircon uses one ZNC process with a separate ZNC account and IRC network per invited GitHub user. It creates and updates them through ZNC's `controlpanel` IRC module and persists changes with `*status SaveConfig`. User changes do **not** restart ZNC or start another ZNC process. The ne2 ZNC migration is complete. The MCP connector has been tested in ChatGPT developer mode. Public onboarding and directory submission are tracked in [ROADMAP.md](ROADMAP.md), and submission is not scheduled.

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
  contents: SQLite users, GitHub identities, browser and agent sessions, registered OAuth clients, hashed OAuth tokens, settings, channel activity with stable entry IDs, per-agent unread cursors and batches, event subscriptions and pending deliveries, outgoing status, and post audit
  backup: yes
secrets:
  file: /var/lib/zircon-secrets/zircon.env
  names: [GITHUB_CLIENT_SECRET, OAUTH_CLIENT_SECRET, SESSION_SECRET, ADMIN_TOKEN, ZNC_ADMIN_PASSWORD, ZNC_USER_SECRET]
outbound_network:
  - github.com:443 (GitHub sign-in token exchange)
  - api.github.com:443 (GitHub identity lookup)
  - 127.0.0.1:6667 (ZNC administration and per-user IRC clients)
  - irc.chonkbase.net:6697 (ZNC upstream over verified TLS)
memory_estimate: Bun observed around 55 MB resident on ne2 before active user load; systemd later accounted about 16 MB for Zircon and 12 MB for ZNC. Reserve 128 MB for Bun, and measure ZNC and Bun per active user before raising the 16-user cap
scheduled_jobs: event delivery on enqueue plus a five-second fallback poll, hourly retention pruning and daily SQLite backup copy
public_irc_client_port: no
znc_web_admin_public: no
```

## One-time ZNC migration on ne2

The ne2 ZNC module now uses `services.znc.mutable = true`. In the pinned nixpkgs module, `mutable = false` deletes and recreates `znc.conf` on service start, so dynamically added users would disappear after a rebuild. Keep the loopback-only `Listener` override; the NixOS ZNC module otherwise provides a public `:5000` listener by default. No ZNC web admin or public IRC client port is needed.

The `zirconctl` account has `Admin = true`, `LoadModule = [ "controlpanel" ]`, and a salted password hash in Nix configuration. Its password is stored only in `/var/lib/zircon-secrets/zircon.env` as `ZNC_ADMIN_PASSWORD`. The old shared `zircon` ZNC account and its password have been removed. When setting up another host, seed the administrator account before enabling `mutable = true`, then verify that a ZNC restart keeps dynamically created accounts. This is a one-time migration, not a per-user restart.

Zircon derives each user's ZNC password using HMAC-SHA256 from the host-only `ZNC_USER_SECRET` and the stable Zircon user ID. Never rotate that secret without a migration: old ZNC account passwords would no longer match. ZNC stores the accounts and upstream buffers under `/var/lib/znc`, so add that directory to backups too. Zircon's own database is in `/var/lib/zircon` and must also be backed up. Zircon writes a verified, consistent SQLite copy to `/var/lib/zircon/backup/zircon.sqlite` on startup and every 24 hours for live-disk snapshot services. Restore both ZNC and Zircon state from the same backup point; if the raw SQLite files are inconsistent, use the copy.

Provisioning sets each ZNC user's IRC real name to `Zircon ChatGPT bridge for <github_login>` by default, then asks ZNC to reconnect that user's network so the upstream IRC server sees it. It disables automatic channel buffer clearing and keeps 500 lines per channel. Existing provisioned users receive the buffer settings without rebuilding their networks. `settings.ircRealname` controls the prefix.

## Zircon configuration

The NixOS module `services.zircon` uses `DynamicUser`, a private state directory, hardened systemd settings, stdout logging, and an environment file outside the Nix store. Supply `environmentFile = "/var/lib/zircon-secrets/zircon.env"`. Put these **names** in that file: `GITHUB_CLIENT_SECRET`, `OAUTH_CLIENT_SECRET`, `SESSION_SECRET`, `ADMIN_TOKEN`, `ZNC_ADMIN_PASSWORD`, `ZNC_USER_SECRET`. GitHub issues `GITHUB_CLIENT_SECRET`; generate the others on ne2.

Set `settings.githubClientId` to the ID of a GitHub OAuth app with callback `https://zircon.chooser.us/login/github/callback`. GitHub handles sign-in; Zircon is the OAuth authorization server for the MCP connector. `settings.oauthRedirectUris` is optional and now only serves the legacy GPT Action client. Add owner-approved IRC servers to `settings.ircNetworks`; it defaults to `chonkbase` at `irc.chonkbase.net:6697` with TLS. The owner has permission to connect Zircon to chonkbase. Users choose among that list and set their own nick at `/settings`. `settings.ircChannels` defines channels the owner can grant in invitations; the current catalog is `#lobby` and `#soup`. The module caps users at 16 by default because ne2 has 1 GB total RAM shared with other services. `historyRetentionDays` defaults to 7 and `historyMaxPerChannel` to 5000 per user and channel.

Example:

```nix
services.zircon = {
  enable = true;
  environmentFile = "/var/lib/zircon-secrets/zircon.env";
  enableDiagnostics = true; # optional, owner-only /admin/events
  settings = {
    githubClientId = "<GitHub OAuth app client ID>";
    zncAdminUser = "zirconctl";
    ircChannels = [ "#lobby" "#soup" ];
    diagnosticsAdminLogins = [ "toppk" ];
  };
};
```

## ChatGPT connector milestone

Configure a custom MCP connection in ChatGPT developer mode with server URL `https://zircon.chooser.us/mcp`. Zircon answers unauthorized requests with a `WWW-Authenticate` link to `/.well-known/oauth-protected-resource`; OAuth server metadata is at `/.well-known/oauth-authorization-server`. ChatGPT can register at `/oauth/register` using its exact callback URL. Zircon accepts the documented `https://chatgpt.com/connector/oauth/{callback_id}` and `https://chatgpt.com/connector_platform_oauth_redirect` forms, and stores the exact URI per client. Registered clients must use S256 PKCE and `resource=https://zircon.chooser.us` throughout authorization and token exchange. Access tokens are opaque, hashed at rest, and bound to the resource. The agent tools are `see_account_information`, `go_online`, `read_history`, `ack_messages`, `search_history`, `send_message`, `get_message_status`, and `go_offline`. Read and write scopes remain `irc:read` and `irc:write`. The old overlapping MCP tool names are removed; ChatGPT must rescan the connector and start a new chat after this release.

The authorization server does **not** advertise RFC 9207 issuer identification, so ChatGPT should use a callback-ID-specific redirect URI as described in [OpenAI's MCP authentication guide](https://developers.openai.com/plugins/build/auth). If ChatGPT shows a different callback, inspect it before changing the server's allowlist. The legacy GPT Action endpoints and optional callback list remain for compatibility; they do not determine MCP redirects.

The consent and settings pages load `/ui.css` and `/logo.png` from Zircon. The app owns its security headers, including the CSP that permits these same-origin assets and the registered ChatGPT redirect origin on the consent page. HAProxy supplies HSTS and `X-Forwarded-*` headers. ChatGPT may call either `/mcp` or `/mcp/`; both use the same handler. OAuth protected-resource discovery also responds at `/.well-known/oauth-protected-resource/mcp`.

When `enableDiagnostics = true`, `GET /admin/events` returns recent IRC activity and metadata for MCP calls and IRC connection changes. It accepts `limit` (1–200) and optional ISO 8601 `since`. The owner can use a signed-in browser session if their GitHub login is in `diagnosticsAdminLogins`; automation can use `Authorization: Bearer <ADMIN_TOKEN>`. Keep that token out of chat and logs. Diagnostics store no OAuth tokens or tool arguments, are capped at 2000 records, and are pruned with the configured history retention. Channel text is returned from the existing per-user history store. Leave diagnostics disabled on deployments that do not need this view.

The tools and event methods return JSON directly, so this version does not need a long-lived response stream. Raise HAProxy's 25-second server timeout if callback verification might take longer through a slow network. Automated tests cover registration, consent, PKCE, resource-bound tokens, independent agent mailboxes, history, posting, presence, subscription verification, signed deliveries and retries. ChatGPT developer mode exercised listing, unread reads, history, search and a send on Zircon 0.5.0. On 2026-10-02 a Work/dot host subscribed successfully on 0.7.1, and Zircon received HTTP 200 for a matching mention callback. A callback response does not show whether ChatGPT started a task. Retest delivery latency and task creation after deploying 0.7.2.

On 2026-10-02, Zircon 0.6.0 captured `zircom are you feeling lucky?` in `#soup`. Later, ChatGPT called `events/subscribe` twice, but both calls failed with MCP `-32015`. The ne2 journal identified the cause: Bun's HTTPS connection requested an all-address DNS lookup, while Zircon's pinned callback lookup returned a scalar address (`results.sort is not a function`). Version 0.7.0 returns the address shape Bun requests and records callback verification failures in owner diagnostics. No subscription or webhook delivery succeeded in that live test. The chat's ordinary tool list does not contain `events/subscribe`: it is a separate MCP protocol method invoked by ChatGPT's event host. [OpenAI's MCP Events guide](https://developers.openai.com/plugins/build/mcp-events) says to use a Work chat on web, Work with Cloud on desktop, or a dot, then ask ChatGPT to monitor an event. After deployment, confirm `events/subscribe` succeeds, `see_account_information.mentionEvents` reports an active subscription, a matching nick mention queues a delivery, and the callback returns 2xx before claiming push delivery works in ChatGPT. An ordinary chat that only calls tools cannot establish this.

The 0.7.1 live mention at 05:28:52.068 UTC was observed at 05:28:52.107 and queued at 05:28:52.109: two milliseconds from capture to queue. The delivery completed with HTTP 200 at 05:28:54.753, 2.644 seconds after queueing. The five-second polling interval could account for much of that delay; the old diagnostics did not record when the callback started, so network and receiver time cannot be separated. Version 0.7.2 adds an immediate worker wake-up and a `delivery_started` record to make the next test conclusive.

Version 0.7.0 adds persistent agent mailbox sessions and their independent unread cursors. The schema migrates on service startup. The persistent SQLite file and its backup copy remain in `/var/lib/zircon`; back up the state before upgrading. Sessions expire after 30 days of inactivity. New outgoing messages get one local history entry when queued; a matching ZNC echo updates that entry in place, avoiding the local/echo duplicate seen on 0.5.0. Existing duplicate entries remain until the configured retention period removes them. History remains the dominant storage cost.

[OpenAI's migration guide](https://learn.chatgpt.com/docs/migrate-custom-gpts) says custom GPT Actions do not transfer to plugins. Its detailed retirement guidance is for Enterprise workspaces; availability for other plans must be checked for the owner. The [public plugin submission guide](https://developers.openai.com/plugins/deploy/submission) describes a universal directory shared by ChatGPT and Codex, but publication requires an approved plugin package and verified developer identity.

## How a new user joins

1. The owner invites a GitHub username with `POST /admin/invite`, authenticated by `ADMIN_TOKEN`, and grants allowed channels such as `#soup`. New accounts start with no channels enabled. Re-inviting preserves already enabled channels that remain allowed; new grants stay off, and revoked grants are removed from the selection.
2. The owner sends the user the private MCP connection. The user connects it, signs in with GitHub, and consents to IRC read access. Zircon binds their GitHub numeric ID on first sign-in.
3. The user visits `/settings` to select an approved IRC server, their own nickname, display name, and channels from the owner's invitation. Saving a changed selection rebuilds that user's ZNC network through `controlpanel` without restarting ZNC; unchecked channels are no longer joined. Previously stored history is retained until normal pruning but is inaccessible through MCP while the channel is disabled.
4. Zircon stays attached to that user's ZNC account while online and records channel activity with stable entry IDs and event and observation timestamps. An agent first calls `see_account_information` to see the nick, server, presence and recent capture, and receives its own mailbox session ID. It passes that ID to `read_history(mode=unread)` and `ack_messages`; ordinary recent and last-hour reads need no acknowledgement. The user can revoke mention subscriptions in `/settings`. `send_message` reports that the line was queued to ZNC; `get_message_status` can later report a matching server echo. `go_offline` disconnects the account's upstream network and local ZNC session for all its agents; `go_online` resumes it.

For the current owner account, deploy this version with `ircChannels = [ "#lobby" "#soup" ]`, then update `toppk`'s invitation to grant both channels. The re-invite keeps `#soup` enabled and leaves the new `#lobby` grant unchecked. Adding that grant does not rebuild or disconnect the existing ZNC session. The owner can opt into `#lobby` later in `/settings`; there is no automatic join.

## Planned work

- Measure live history retention, replay behavior, Bun/ZNC memory per user and storage per channel per day on ne2. Channel activity is stored per user in SQLite, but these capacity figures are not yet measured.
- Add `message.channel` and richer event filters after the first mention-event path is proven in ChatGPT. [OpenAI's Events guide](https://developers.openai.com/plugins/build/mcp-events) currently limits Events to Work chats on web, Work chats on desktop with Cloud, and dots, subject to workspace controls; the tools work without Events.
- Measure the event worker on ne2. Version 0.7.2 wakes it immediately when a mention is queued; a five-second queue poll remains as a fallback and for retries. It sends one delivery at a time, drains at most 10 per pass, and caps queued deliveries at 1000. `/admin/events` records `queued`, `delivery_started`, and `delivery` with the same event ID so queue wait and callback time can be measured separately. IRC line limits make typical payloads much smaller than the 256 KiB protocol ceiling; reserve about 4 MiB extra Bun memory for the worker until measured. Subscriptions store callback URLs and `whsec_` signing secrets in the private SQLite state. No additional host environment secret is needed. The `/privacy` page describes event text sent to OpenAI.
- Test `see_account_information`, all three `read_history` modes, `get_message_status`, `go_online` and `go_offline` through ChatGPT after deployment. `send_message` was tested live on 0.5.0. MCP posts require an idempotency key, are limited to 20 per user and 60 per network per minute, and report queued rather than delivered.
- Test two agent sessions under one OAuth client: both should see the same retained IRC activity, but acknowledging one session's unread batch must not advance the other. The human's ZNC presence remains shared. Mention subscriptions are tracked by OAuth client and ChatGPT callback URL, not by agent mailbox session.
- Replace invite-only onboarding with bounded self-service signup, owner-approved channel opt-in, abuse controls and per-user/per-network kill switches. Keep `MAX_USERS=16` on ne2 until memory and ZNC cost per active user are measured.
- Add self-service deletion, a documented retention policy, an updated privacy page, terms, support contact and reviewer test account. Current `/privacy` describes the current data only.
- Build the plugin ZIP and supply the verified developer identity, domain verification, listing assets, review test cases and credentials required by the [submission guide](https://developers.openai.com/plugins/deploy/submission) and [review requirements](https://developers.openai.com/plugins/deploy/app-review). Recheck both just before submission.

The [roadmap](ROADMAP.md) records these as issues for a possible future submission. It also covers the settings and consent UX, reviewer credentials, mobile testing and the authorization record for chonkbase.

For a local protocol check against a temporary ZNC instance, run `bun tools/check-znc.js /path/to/znc`. It verifies account creation, TLS server and channel configuration, saved state, and client login without a restart.
