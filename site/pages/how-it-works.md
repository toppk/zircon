---
title: How it works
eyebrow: Start
lede: One Bun process, one SQLite file and one ZNC. Zircon is the OAuth server for ChatGPT, a GitHub sign-in for people, and a ZNC administrator behind both.
description: Zircon's architecture, identities, storage and limits.
---

## The pieces

Zircon
: A Bun HTTP service on `127.0.0.1:3000`. It serves the
  MCP endpoint, OAuth discovery, the sign-in and settings pages, the
  admin invite endpoint and the IRC API. A reverse proxy (HAProxy on the
  reference host) supplies public HTTPS.

ZNC
: One ZNC process holds an account and network per Zircon user, plus a
  dedicated administrator account (`zirconctl` by default) with the
  `controlpanel` module. ZNC keeps the upstream IRC connections and their
  buffers.

SQLite
: `zircon.sqlite` under `/var/lib/zircon` holds users, GitHub identities,
  browser sessions, hashed OAuth tokens, settings and the post audit. Zircon
  also writes a consistent copy under `backup/` on startup and daily for
  whole-disk snapshots.

## Identities

There are three, and Zircon keeps them separate.

| identity | who issues it | what it is for |
|---|---|---|
| GitHub account | GitHub | proving who a person is when they sign in |
| Zircon OAuth token | Zircon | letting a registered MCP client act for that person, scoped `irc:read` and bound to this server |
| ZNC account | Zircon, through `controlpanel` | that person's own IRC connection, nick and buffers |

Zircon binds a GitHub user's numeric ID on their first sign-in, so a
renamed GitHub login stays attached to the same Zircon user. Each user's
ZNC password is derived with HMAC-SHA256 from the host secret
`ZNC_USER_SECRET` and the stable Zircon user ID, so Zircon never stores it.

::: warning
Rotating `ZNC_USER_SECRET` changes every derived ZNC password. Do not rotate
it without a migration.
:::

## Provisioning without restarts

When a user saves `/settings`, or first uses the API, Zircon logs into ZNC
as the administrator and uses `controlpanel` to create or update that
user's account and network: server, nick, real name (`Zircon ChatGPT bridge for <GitHub login>` by default) and enabled channels.
Zircon reconnects that ZNC network so IRC sees a changed real name.
It then runs `SaveConfig`. ZNC must run with `mutable = true` so that
saved configuration survives a restart; [Deployment](deploy.html) covers
the one-time migration.

Zircon then attaches to the user's ZNC account as an IRC client and keeps
recent lines for the API to read. MCP currently exposes read-only tools; persistent history and public onboarding are planned.

## Channels: granted, then enabled

The owner lists the channels Zircon may ever offer (`ircChannels`). An
invitation grants a user some of those. The user then enables any of their
granted channels for ChatGPT in `/settings`. The API only reads and posts
in enabled channels.

## Limits

- 16 users by default (`maxUsers`, up to 100). The reference host has 1 GB
  of RAM shared with other services.
- Messages are one line, 1 to 400 characters.
- 20 posts per user per minute; reads return up to 200 lines.
- Request bodies are capped at 4 KiB.
