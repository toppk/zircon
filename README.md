# Zircon

Zircon is a Bun/JavaScript service that connects ChatGPT to an IRC network through a **local ZNC bouncer**. ZNC holds the upstream IRC connection and buffers messages while Zircon restarts. Zircon exposes a small OAuth-protected HTTP API on `127.0.0.1:3000` for the host's HTTPS proxy. It keeps at most 500 received messages per allowed channel in memory; its own history disappears on restart and is replenished from ZNC's replay buffer.

## Authentication

Use an established OpenID Connect provider such as Auth0 or Keycloak to issue RS256 JWT access tokens for Zircon's API. Zircon uses `jose` to validate signature, issuer, audience, expiry, subject, and `irc:read` or `irc:write` scope. It does not issue tokens or manage user passwords. `OIDC_ALLOWED_SUBJECTS` restricts which provider users may act through the shared ZNC account.

For a Custom GPT Action, choose OAuth in the GPT editor, enter your provider's authorization and token URLs, client ID, client secret, and scopes, then import `https://zircon.chooser.us/openapi.json`. Register the exact ChatGPT callback URL with the provider. [Official OpenAI Action authentication documentation](https://developers.openai.com/api/docs/actions/authentication)

An MCP plugin requires a separate MCP adapter and OAuth discovery. [Official OpenAI plugin authentication documentation](https://developers.openai.com/plugins/build/auth)

## IRC and ZNC

Infra provides ZNC on the same host. Zircon connects over the IRC protocol to `127.0.0.1:6697` by default and authenticates with `PASS user/network:password`. The ZNC account and network must already exist. Set ZNC to join the channels listed in `IRC_CHANNELS` and keep enough buffer lines for the desired replay window. Zircon sends `JOIN` for those channels at login as well.

The ZNC password belongs in the systemd environment file outside the Nix store. Zircon's loopback TCP connection to ZNC is unencrypted; configure ZNC's client listener on loopback only. ZNC handles TLS to the upstream IRC server.

## Deployment

The [deployment requirements](DEPLOY.md) follow the bllue.org handoff. This repo exposes `packages.x86_64-linux.default` and `nixosModules.default` in [flake.nix](flake.nix). Infra imports the module, supplies the local ZNC account, provisions the secret file, and routes HTTPS from HAProxy.

Example host configuration:

```nix
services.zircon = {
  enable = true;
  environmentFile = "/run/secrets/zircon.env";
  settings = {
    oidcIssuer = "https://identity.example.com/";
    oidcJwksUrl = "https://identity.example.com/.well-known/jwks.json";
    allowedSubjects = [ "provider-user-id" ];
    zncNetwork = "example";
    ircChannels = [ "#example" ];
  };
};
```

The secret file must contain `ZNC_PASSWORD=...`. No secret belongs in `settings`. The service runs as a dynamic user with state directory `/var/lib/zircon`, binds loopback only, and has `GET /healthz` for the HAProxy health check. Check with `nix build .#default` and `nix flake check` after committing or staging the flake files.

## API and tests

The API has `GET /v1/status`, `GET /v1/channels/{channel}/messages?limit=50`, and `POST /v1/channels/{channel}/messages` with JSON `{"text":"hello"}`. Use the channel name without `#` in the path. Sending requires `irc:write`; reading requires `irc:read`. Requests are limited to 4 KiB. Run `bun install` and `bun test` for local tests.
