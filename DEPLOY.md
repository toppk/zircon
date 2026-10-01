# Zircon deployment requirements

Zircon uses one ZNC process with a separate ZNC account and IRC network per invited GitHub user. It creates and updates them through ZNC's `controlpanel` IRC module and persists changes with `*status SaveConfig`. User changes do **not** restart ZNC or start another ZNC process. The initial ne2 migration does require changing ZNC's NixOS configuration once.

```yaml
app: zircon
hostname: zircon.chooser.us
listen_address: 127.0.0.1
listen_port: 3000
health_path: /healthz
websockets: no
max_request_body: 4k
state:
  path: /var/lib/zircon
  contents: SQLite users, GitHub identities, sessions, hashed OAuth tokens, settings and post audit
  backup: yes
secrets:
  file: /var/lib/zircon-secrets/zircon.env
  names: [GITHUB_CLIENT_SECRET, OAUTH_CLIENT_SECRET, SESSION_SECRET, ADMIN_TOKEN, ZNC_ADMIN_PASSWORD, ZNC_USER_SECRET]
outbound_network:
  - github.com:443 (GitHub sign-in token exchange)
  - api.github.com:443 (GitHub identity lookup)
  - 127.0.0.1:6667 (ZNC administration and per-user IRC clients)
  - irc.chonkbase.net:6697 (ZNC upstream over verified TLS)
memory_estimate: reserve 128 MB for Bun; ZNC's additional per-user connections and 500-line buffers need a ne2 load measurement before raising the 16-user cap
scheduled_jobs: none
public_irc_client_port: no
znc_web_admin_public: no
```

## One-time ZNC migration on ne2

The deployed ZNC module has `services.znc.mutable = false`. In the pinned nixpkgs module, that mode deletes and recreates `znc.conf` on service start, so dynamically added users would disappear after a rebuild. Change it to `mutable = true` **after** seeding a dedicated administrator account with the `controlpanel` user module. Keep the existing loopback-only `Listener` override; the NixOS ZNC module otherwise provides a public `:5000` listener by default. No ZNC web admin or public IRC client port is needed.

Seed the `zirconctl` account with `Admin = true`, `LoadModule = [ "controlpanel" ]`, and a salted password hash in Nix configuration. Generate the password on ne2, place its value only in `/var/lib/zircon-secrets/zircon.env` as `ZNC_ADMIN_PASSWORD`, and put only its salted hash in Nix. Set `ZNC_ADMIN_USER=zirconctl` through the Zircon module's public setting. The existing `zircon` account and its `ZNC_PASSWORD` may remain for the old buffer, but Zircon no longer uses that shared identity. As the current ZNC is already running with `mutable = false`, apply the admin account in one system-managed configuration first, then enable `mutable = true` and verify that a ZNC restart no longer removes dynamically created accounts. This is a one-time migration, not a per-user restart.

Zircon derives each user's ZNC password using HMAC-SHA256 from the host-only `ZNC_USER_SECRET` and the stable Zircon user ID. Never rotate that secret without a migration: old ZNC account passwords would no longer match. ZNC stores the accounts and upstream buffers under `/var/lib/znc`, so add that directory to backups too. Zircon's own database is in `/var/lib/zircon` and must also be backed up. Restore both stores together.

## Zircon configuration

The NixOS module `services.zircon` uses `DynamicUser`, a private state directory, hardened systemd settings, stdout logging, and an environment file outside the Nix store. Supply `environmentFile = "/var/lib/zircon-secrets/zircon.env"`. Put these **names** in that file: `GITHUB_CLIENT_SECRET`, `OAUTH_CLIENT_SECRET`, `SESSION_SECRET`, `ADMIN_TOKEN`, `ZNC_ADMIN_PASSWORD`, `ZNC_USER_SECRET`. GitHub issues `GITHUB_CLIENT_SECRET`; generate the others on ne2. The old `ZNC_PASSWORD` may stay there for the existing ZNC account; Zircon does not read it.

Set `settings.githubClientId` to the ID of a GitHub OAuth app with callback `https://zircon.chooser.us/login/github/callback`. GitHub handles sign-in; Zircon remains the authorization server for the GPT Action. Set `settings.oauthRedirectUris` to the **exact** callback URL shown in the GPT Action builder. Add owner-approved IRC servers to `settings.ircNetworks`; it defaults to `chonkbase` at `irc.chonkbase.net:6697` with TLS. Users choose among that list and set their own nick at `/settings`. `settings.ircChannels` defines channels the owner can grant in invitations, initially `#soup`. The module caps users at 16 by default because ne2 has 1 GB total RAM shared with other services.

Example:

```nix
services.zircon = {
  enable = true;
  environmentFile = "/var/lib/zircon-secrets/zircon.env";
  settings = {
    githubClientId = "<GitHub OAuth app client ID>";
    oauthRedirectUris = [ "https://chatgpt.com/aip/g-.../oauth/callback" ];
    zncAdminUser = "zirconctl";
    ircChannels = [ "#soup" ];
  };
};
```

## ChatGPT surface

The supported surface is a **Custom GPT Action**. Import `https://zircon.chooser.us/openapi.json`, configure OAuth authorization URL `https://zircon.chooser.us/oauth/authorize`, token URL `https://zircon.chooser.us/oauth/token`, client ID `zircon-chatgpt` (or `settings.oauthClientId`), the host-generated `OAUTH_CLIENT_SECRET`, and scopes `irc:read irc:write`. Zircon accepts authorization code with optional S256 PKCE, since [GPT Action authentication](https://developers.openai.com/api/docs/actions/authentication) does not document PKCE. It always requires the confidential client secret. Use `https://zircon.chooser.us/privacy` as the Action privacy URL after the owner reviews its text; [OpenAI requires a valid privacy URL for a public GPT with Actions](https://help.openai.com/en/articles/9442513-configuring-actions-in-gpts).

[OpenAI's current GPT FAQ](https://help.openai.com/en/articles/8554407-gpts-faq) says Free users can use GPTs they can access, while new GPT creation and publishing are unavailable on personal Free, Go, Plus and Pro accounts. The builder needs an eligible managed workspace. [MCP apps and full write support](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt) have different workspace rules; Zircon does not expose MCP or the Apps SDK. Recheck plan rules when publishing.

## How a new user joins

1. The owner invites a GitHub username with `POST /admin/invite`, authenticated by `ADMIN_TOKEN`, and assigns allowed channels such as `#soup`.
2. The owner sends the user the GPT link. The user connects its Action, signs in with GitHub, and consents to IRC read/write access. Zircon binds their GitHub numeric ID on first sign-in.
3. The user visits `/settings` to select an approved IRC server, their own nickname, display name, and channels from the owner's invitation. Zircon updates their separate ZNC account through `controlpanel` and saves ZNC's configuration.
4. When ChatGPT calls the Action, Zircon attaches to that user's ZNC account. Messages go out under that user's IRC nick, and the user's channel buffer is isolated from other users.

Until ne2 has the mutable ZNC administrator account, Zircon's per-user IRC API will return `503 IRC setup unavailable`; do not switch HAProxy from the placeholder before that migration and a live end-to-end test.

For a local protocol check against a temporary ZNC instance, run `bun tools/check-znc.js /path/to/znc`. It verifies account creation, TLS server and channel configuration, saved state, and client login without a restart.
