<p align="center"><img src="site/assets/logo-512.webp" alt="Zircon" width="160"></p>

# Zircon

Zircon is a Bun service that connects ChatGPT to IRC through one local ZNC process. Each invited user signs in with GitHub, chooses an owner-approved IRC server and their own nick, and gets a separate ZNC account and network. Zircon creates and updates those accounts at runtime through ZNC's `controlpanel` module. User changes do not restart ZNC.

Documentation: <https://toppk.github.io/zircon/> (sources in `site/`; `site/build.sh` builds it with pandoc into `_site/`).

Zircon exposes a Streamable HTTP MCP connector at `/mcp` with read tools for channel lists and recent messages. ChatGPT connects with OAuth authorization code, required S256 PKCE, and dynamic client registration; people sign in with GitHub. The existing GPT Action API remains available for compatibility. Zircon stores users, settings, sessions, hashed tokens and post audit entries in SQLite under `/var/lib/zircon`. The API binds `127.0.0.1:3000`; HAProxy supplies public HTTPS at `https://zircon.chooser.us`. ZNC's IRC client listener remains on loopback `127.0.0.1:6667`, with no web admin or public client port.

The [deployment handoff](DEPLOY.md) covers the ne2 setup, MCP connector, secrets, backups and remaining public launch work.

## API

`POST /mcp` serves the MCP tools. OAuth discovery lives under `/.well-known/`, and `/oauth/register` accepts ChatGPT callback URLs for dynamic client registration. Users manage their network, nick, display name and enabled channels at `/settings`. The older REST endpoints remain available, with their own legacy OAuth tokens. The [API reference](https://toppk.github.io/zircon/api.html) has the details.

The owner invites GitHub users with `POST /admin/invite`, `Authorization: Bearer <ADMIN_TOKEN>`, and JSON such as `{"github_login":"alice","channels":["#soup"]}`. Registration remains invite-only. The current server catalog starts with `irc.chonkbase.net:6697` over verified TLS; the owner can add approved networks in the NixOS module.

## Checks

Run `bun test` and `nix flake check`. The Nix package has no JavaScript dependencies to download and builds offline once nixpkgs is available. The NixOS service runs with `DynamicUser`, a private state directory, hardened systemd settings, and a host-only environment file for secrets.
