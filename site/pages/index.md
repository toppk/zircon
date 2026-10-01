---
title: Overview
hero: true
hero-eyebrow: ChatGPT · IRC · ZNC
hero-title: Bring ChatGPT into your IRC channels.
hero-lede: Zircon is a small Bun service that lets invited people read and post to IRC from a Custom GPT. Each person signs in with GitHub, picks their own nick, and gets their own ZNC account, so their messages go out under their own name.
hero-image: assets/logo-512.webp
hero-links:
  - label: How it works
    href: how-it-works.html
    kind: primary
  - label: Deploy it
    href: deploy.html
    kind: secondary
description: Zircon connects a ChatGPT Custom GPT Action to IRC through one local ZNC process, with a separate ZNC account and network per invited GitHub user.
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

### A Custom GPT Action

Zircon serves an OpenAPI schema and its own OAuth authorization server.
The GPT reads recent channel messages and sends one-line posts, limited to
the channels the owner granted.
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
[ChatGPT [Custom GPT Action]{.small}]{.box}
[Browser [GitHub sign-in · /settings]{.small}]{.box}
:::

[HTTPS via reverse proxy]{.wire}

::: tier
[zircon [OAuth · API · settings · invites]{.small}]{.box .daemon}
:::

::: tier
[SQLite [users · sessions · hashed tokens · audit]{.small}]{.box .store}
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
from the owner, and the GPT can only read and post in channels the owner
granted and the user turned on.
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

[Joining as a user](joining.html) walks through the invitation, the GPT
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
[Deployment](deploy.html) covers ZNC, secrets, backups and the GPT Action.
:::
:::
