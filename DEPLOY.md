# Zircon deployment requirements

Source: bllue.org app handoff at commit `6b3777a` and ne2 ZNC deployment at commits `0725218`, `5d7f167`.

Deployment is pending the authentication redesign (Zircon-owned OAuth server and per-user configuration).

```yaml
app: zircon
hostname: zircon.chooser.us
repo: git+file:///home/toppk/workspace/zircon
listen_port: 3000
listen_address: 127.0.0.1
health_path: /healthz
websockets: no
max_request_body: 4k
state:
  path: /var/lib/zircon
  size_estimate: pending auth redesign; current history is in memory
  backup: pending decision on persistent user data
secrets:
  - ZNC_PASSWORD
outbound_network:
  - 127.0.0.1:6667 (ZNC client listener, plain TCP)
  - OIDC_JWKS_URL:443 (temporary external identity provider JWKS; redesign pending)
  - irc.chonkbase.net:6697 (ZNC upstream over verified TLS)
memory_estimate: 71 MB measured idle RSS; reserve 128 MB for Zircon
scheduled_jobs: none
znc:
  how_zircon_talks_to_it: IRC over loopback TCP using PASS zircon/chonkbase:password
  znc_modules_needed: []
  irc_networks: [chonkbase]
  public_irc_client_port: no
  znc_web_admin_public: no
other_hostnames: none
```

ZNC is live on ne2 with a loopback-only client listener, a non-admin `zircon` account, and a `#soup` buffer retained after replay. The root-only environment file already exists at `/var/lib/zircon-secrets/zircon.env` and contains `ZNC_PASSWORD`.

The current design uses one shared IRC identity. If the auth redesign requires an IRC identity for each user, infra must change ZNC to mutable mode and provide an admin ZNC account for account creation. Flag this before deploying the app. Decide whether user data will persist in `/var/lib/zircon` before infra finalizes backup notes.

The current integration is a Custom GPT Action. An MCP plugin needs an additional adapter and OAuth discovery before ChatGPT can connect through that surface.
