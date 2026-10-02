# Zircon roadmap

Zircon currently runs as a private ChatGPT developer-mode MCP connection. Public Directory submission is not scheduled. The owner has permission to connect Zircon to irc.chonkbase.net; retain that authorization record when preparing a submission. Other IRC networks require their own authorization review before being offered publicly.

## Near-term product work

- [ ] **Make settings and authorization screens usable.** Redesign `/settings`, `/login`, and OAuth consent for clear explanations, readable spacing, responsive mobile layout, useful validation errors, and obvious save/approval outcomes. Test the complete GitHub sign-in and consent flow in desktop and mobile browsers. Keep CSRF protection and the narrow consent scopes.
- [ ] **Deliver MCP Events.** Add the current MCP Events protocol and `message.mention` first, then filtered `message.channel`. Persist subscriptions, enforce channel access and TTL, expose revocation in settings, validate callback destinations against SSRF, sign deliveries, bound the worker queue and retries, and suppress events for Zircon's own posts. Keep the tools useful without Events.
- [ ] **Measure live history behavior.** Verify ZNC server-time replay, buffer persistence, reconnects, duplicates, retention pruning, and search/mention results on ne2. Measure Bun and ZNC memory per active user and stored bytes per channel per day before raising the 16-user cap.
- [ ] **Harden public write access before opening signup.** Add owner-approved channel opt-in, per-user and per-network disable controls, new-account quotas, and abuse review. Keep arbitrary IRC destinations unavailable until permission and moderation are settled.
- [ ] **Complete data lifecycle.** Add self-service account deletion covering OAuth sessions/tokens, settings, history and the ZNC account. Specify backup expiry and deletion timing. Update the privacy page with categories, purposes, recipients, retention, and controls; add terms and a working support contact. Never ask users for NickServ or other IRC credentials.

## Directory preparation, when publication is chosen

- [ ] **Reviewer access.** Provide a fully featured demo account with a username and password, sample channel history, and posting access. Review must not depend on GitHub signup, new-device approval, or inaccessible 2FA. Limit and rotate reviewer credentials separately from normal GitHub sign-in.
- [ ] **Listing and ownership.** Use the explicit name **Zircon IRC**, describe the permitted chonkbase integration accurately, keep evidence of permission, verify developer identity and domain, and provide support contact, prompts, and required package assets. Recheck the [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines) and [submission process](https://developers.openai.com/plugins/deploy/submission) immediately before submission.
- [ ] **Review quality.** Test every tool and error case in ChatGPT on desktop and mobile. Check annotations, scopes, confirmations, response minimization, privacy text, and safe retry behavior against the then-current guidance. Remove temporary proxy workarounds after app fixes deploy. Submit only after the feature set is complete and stable.

The private connector can continue to be used while these items are open. Directory publication is a separate decision.
