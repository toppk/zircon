---
title: Overview
hero: true
hero-eyebrow: ChatGPT · IRC · ZNC
hero-title: Bring ChatGPT into your IRC channels.
hero-lede: Zircon is a small Bun service with an MCP connector for IRC in ChatGPT. Each invited person signs in with GitHub, picks their own nick, and gets their own ZNC account. Read and search history, check mentions, and send messages.
hero-image: assets/logo-512.webp
hero-links:
  - label: How it works
    href: how-it-works.html
    kind: primary
  - label: Deploy it
    href: deploy.html
    kind: secondary
description: Zircon connects ChatGPT to IRC through an MCP server and one local ZNC process, with a separate ZNC account per invited GitHub user.
---

## What Zircon does

::: cards
::: card
[People]{.label}

### One identity each

Invited users sign in with GitHub and choose an owner-approved IRC server
and their own nick. Zircon creates a separate ZNC account and network for
each of them, so nobody posts as anyone else.
:::

::: card
[ChatGPT]{.label}

### An MCP connector

Zircon serves MCP tools and its own OAuth authorization server. ChatGPT
can list channels, read and search timestamped history, check mentions,
send messages, and take the user's IRC network online or offline.
:::

::: card
[ZNC]{.label}

### No restarts

Accounts are created and updated at runtime through ZNC's `controlpanel`
module and saved with `SaveConfig`. Adding a user or changing a nick never
restarts ZNC.
:::
:::

## How it fits together

::: stack
::: tier
[ChatGPT [MCP connector]{.small}]{.box}
[Browser [GitHub sign-in · /settings]{.small}]{.box}
:::

[HTTPS via reverse proxy]{.wire}

::: tier
[zircon [MCP · OAuth · settings · invites]{.small}]{.box .daemon}
:::

::: tier
[SQLite [users · history · hashed tokens · audit]{.small}]{.box .store}
[ZNC [one account per user, loopback only]{.small}]{.box .socket}
:::

[TLS]{.wire}

::: tier
[IRC networks [owner-approved]{.small}]{.box}
:::
:::

## What it promises

::: safety
**Invite only, channel limited.** Nobody can sign in without an invitation
from the owner, and the MCP tools can only use channels the owner granted
and the user turned on.
:::

- **Tokens are hashed.** Zircon stores OAuth access and refresh tokens
  hashed, and does not keep the GitHub access token after sign-in.
- **Everything is loopback.** The API listens on `127.0.0.1:3000` and ZNC's
  client listener on `127.0.0.1:6667`. There is no ZNC web admin and no
  public IRC client port.
- **Posts are audited.** Every accepted message is logged with who sent it
  and where.
- **Small on purpose.** No JavaScript dependencies, one SQLite file, and a
  hardened NixOS service.

## Where to go next

::: cards
::: card
### Using Zircon

[Joining as a user](joining.html) walks through the invitation, the connector
sign-in and `/settings`.
:::

::: card
### Building on it

The [API reference](api.html) covers OAuth, the bearer endpoints and the
admin invite call.
:::

::: card
### Running it

[Configuration](configuration.html) lists every setting, and
[Deployment](deploy.html) covers ZNC, secrets, backups and the MCP connector.
:::
:::
