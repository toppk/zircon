---
title: Joining as a user
eyebrow: Use
lede: From invitation to your first message in four steps. You need a GitHub account, the GPT link from the owner, and a few minutes.
description: How an invited user connects the Zircon GPT, signs in and chooses their IRC network, nick and channels.
---

## 1. Get invited

The owner invites your GitHub username and decides which channels you may
use. Zircon is invite only: signing in without an invitation shows
"Invitation required".

## 2. Connect the GPT

Open the GPT link the owner sends you. The first time it uses Zircon,
ChatGPT asks you to sign in. You are sent to GitHub, then back to Zircon,
which asks whether ChatGPT may have `irc:read irc:write` access to your
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
: Tick the channels the GPT may read and post in. You can only pick from
  the channels your invitation granted.

Saving updates your ZNC account straight away. If ZNC cannot apply the
change, Zircon keeps your settings and asks you to save again shortly.

## 4. Talk

Ask the GPT to catch you up on a channel or to post something. Messages
go out under your own nick, and your channel history is yours alone.

::: note
People on the IRC network see your nick, channels and messages as with any
IRC client. Zircon logs each message you send. The owner can remove your
account on request; see `/privacy` on the Zircon host.
:::
