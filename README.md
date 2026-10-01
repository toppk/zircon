<p align="center"><img src="site/assets/logo-512.webp" alt="Zircon" width="160"></p>

# Zircon

Zircon is a Bun service that connects ChatGPT to IRC through one local ZNC process. Each invited user signs in with GitHub, chooses an owner-approved IRC server and their own nick, and gets a separate ZNC account and network. Zircon creates and updates those accounts at runtime through ZNC's `controlpanel` module. User changes do not restart ZNC.

Documentation: <https://toppk.github.io/zircon/> (sources in `site/`; `site/build.sh` builds it with pandoc into `_site/`).

Zircon provides OAuth authorization code and refresh tokens for a Custom GPT Action. It stores users, settings, sessions, hashed tokens and post audit entries in SQLite under `/var/lib/zircon`. The API binds `127.0.0.1:3000`; HAProxy supplies public HTTPS at `https://zircon.chooser.us`. ZNC's IRC client listener remains on loopback `127.0.0.1:6667`, with no web admin or public client port.

The [deployment handoff](DEPLOY.md) covers the required one-time ne2 ZNC migration to a mutable configuration and a dedicated administrator account, secrets, backup, GPT Action setup and a user walkthrough. Do not route public traffic to Zircon until that migration and a live end-to-end check are complete.

## API

`GET /openapi.json` serves the GPT Action schema. `/oauth/authorize`, `/oauth/token` and `/oauth/revoke` implement Zircon's OAuth flow. Users manage their network, nick, display name and enabled channels at `/settings`. OAuth bearer endpoints are `GET /v1/status`, `GET /v1/channels/{channel}/messages` and `POST /v1/channels/{channel}/messages` with JSON `{"text":"hello"}`. Omit `#` from the channel path. Zircon enforces the owner's channel grants and logs each accepted post. The [API reference](https://toppk.github.io/zircon/api.html) has the details.

The owner invites GitHub users with `POST /admin/invite`, `Authorization: Bearer <ADMIN_TOKEN>`, and JSON such as `{"github_login":"alice","channels":["#soup"]}`. Registration remains invite-only. The current server catalog starts with `irc.chonkbase.net:6697` over verified TLS; the owner can add approved networks in the NixOS module.

## Checks

Run `bun test` and `nix flake check`. The Nix package has no JavaScript dependencies to download and builds offline once nixpkgs is available. The NixOS service runs with `DynamicUser`, a private state directory, hardened systemd settings, and a host-only environment file for secrets.
