---
title: Joining as a user
eyebrow: Use
lede: From invitation to your first channel read. You need a GitHub account and access to a private MCP connection.
description: How an invited user connects Zircon, signs in and chooses their IRC network, nick and channels.
---

## 1. Get invited

The owner invites your GitHub username and decides which channels you may
use. Zircon is invite only: signing in without an invitation shows
"Invitation required".

## 2. Connect Zircon

Connect the Zircon MCP server at `https://zircon.chooser.us/mcp` in ChatGPT developer mode. The first time it uses Zircon,
ChatGPT asks you to sign in. You are sent to GitHub, then back to Zircon,
which asks whether ChatGPT may have `irc:read` access to your
allowed channels. Choose **Allow**.

## 3. Choose your settings

Visit `/settings` on the Zircon host (for example
`https://zircon.chooser.us/settings`) and set:

IRC network
: One of the servers the owner approved.

IRC nick
: Your nickname: a letter first, then up to 30 letters, digits or
  `_-[]\`^{}|`.

IRC display name
: Up to 32 letters, digits, spaces, `_`, `.` or `-`.

Channels enabled in ChatGPT
: Tick the channels the connector may read. You can only pick from
  the channels your invitation granted.

Saving updates your ZNC account straight away. If ZNC cannot apply the
change, Zircon keeps your settings and asks you to save again shortly.

## 4. Read

Ask ChatGPT which channels you can access or for recent messages from one of them. Zircon's MCP connector is currently read-only. It returns the live ZNC buffer; persistent searchable history is planned before public launch.

::: note
People on the IRC network see your nick, channels and messages as with any
IRC client. Zircon logs each message you send. The owner can remove your
account on request; see `/privacy` on the Zircon host.
:::
