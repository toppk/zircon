---
title: Configuration
eyebrow: Run
lede: Non-secret settings live in the NixOS module; secrets live in one host-only environment file.
description: Zircon NixOS module options, environment variables and secrets.
---

## NixOS module

The flake exports `nixosModules.default`, which defines
`services.zircon`.

```nix
services.zircon = {
  enable = true;
  environmentFile = "/var/lib/zircon-secrets/zircon.env";
  settings = {
    githubClientId = "<GitHub OAuth app client ID>";
    ircChannels = [ "#soup" ];
  };
};
```

| option | default | meaning |
|---|---|---|
| `port` | `3000` | loopback HTTP port for the reverse proxy |
| `maxUsers` | `16` | most users Zircon will create (1 to 100) |
| `historyRetentionDays` | `7` | maximum days of channel history (1 to 365) |
| `historyMaxPerChannel` | `5000` | maximum entries per user and channel (100 to 100000) |
| `environmentFile` | none, required | secrets file outside `/nix/store` |
| `settings.publicBaseUrl` | `https://zircon.chooser.us` | public HTTPS origin |
| `settings.githubClientId` | required | GitHub OAuth app client ID |
| `settings.oauthClientId` | `zircon-chatgpt` | legacy GPT Action client ID |
| `settings.oauthRedirectUris` | `[]` | optional exact legacy GPT Action callback URLs |
| `settings.zncPort` | `6667` | ZNC's loopback IRC listener |
| `settings.zncAdminUser` | `zirconctl` | ZNC administrator with `controlpanel` |
| `settings.ircNetworks` | `chonkbase`, `irc.chonkbase.net:6697`, TLS | owner-approved servers users may pick |
| `settings.ircUsername` | `zircon` | IRC username (ident) |
| `settings.ircRealname` | `Zircon ChatGPT bridge` | prefix for each user's IRC real name; their GitHub login is appended |
| `settings.ircChannels` | required | channels the owner may grant |

The service runs with `DynamicUser`, `StateDirectory=zircon`,
`ProtectSystem=strict`, no capabilities, and logs to stdout.

## Secrets

Put these names in the host environment file. GitHub issues
`GITHUB_CLIENT_SECRET`; generate the others on the host. Every secret
except `ZNC_ADMIN_PASSWORD` must be at least 32
characters.

| name | used for |
|---|---|
| `GITHUB_CLIENT_SECRET` | GitHub sign-in token exchange |
| `OAUTH_CLIENT_SECRET` | legacy GPT Action client secret; still required by current configuration |
| `SESSION_SECRET` | CSRF tokens for the browser pages |
| `ADMIN_TOKEN` | the owner's `POST /admin/invite` bearer token |
| `ZNC_ADMIN_PASSWORD` | the ZNC administrator account |
| `ZNC_USER_SECRET` | deriving each user's ZNC password |

```sh
openssl rand -base64 48   # one per secret
```

## Environment variables

Outside NixOS, Zircon reads the same settings from the environment:
`PUBLIC_BASE_URL`, `GITHUB_CLIENT_ID`, `OAUTH_CLIENT_ID`,
`OAUTH_REDIRECT_URIS` (optional, comma separated), `IRC_CHANNELS` (comma separated),
`IRC_NETWORKS_JSON`, `ZNC_ADMIN_USER`, plus optional `PORT`, `MAX_USERS`,
`HISTORY_RETENTION_DAYS`, `HISTORY_MAX_PER_CHANNEL`,
`STATE_DIR` (default `/var/lib/zircon`), `ZNC_HOST`, `ZNC_PORT`,
`IRC_USERNAME` and `IRC_REALNAME`.

```sh
bun run src/index.js
```

## Checks

```sh
bun test
nix flake check
```
