# Zircon deployment requirements

Source: bllue.org app handoff at commit `6b3777a`.

```yaml
app: zircon
hostname: zircon.chooser.us
repo: pending; no git remote is configured for this repository
listen_port: 3000
listen_address: 127.0.0.1
health_path: /healthz
websockets: no
max_request_body: 4k
state:
  path: /var/lib/zircon
  size_estimate: 0 MB; current history is in memory, ZNC owns IRC buffers
  backup: no
secrets:
  - ZNC_PASSWORD
outbound_network:
  - 127.0.0.1:6697 (ZNC client listener; port configurable)
  - OIDC_JWKS_URL:443 (identity provider JWKS)
  - IRC upstream host:6697 (ZNC to the configured network; actual host pending)
memory_estimate: 71 MB measured idle RSS; reserve 128 MB for Zircon
scheduled_jobs: none
znc:
  how_zircon_talks_to_it: IRC over loopback TCP using PASS user/network:password
  znc_modules_needed: []
  irc_networks: [to be configured by infra]
  public_irc_client_port: no
  znc_web_admin_public: no
other_hostnames: none
```

ZNC connects onward to the configured IRC server over TLS, usually port 6697. Its upstream hostname and network name must be supplied by infra. Configure ZNC's client listener on loopback and provision a dedicated ZNC user for Zircon. The ZNC account's network should autojoin the configured channels and retain buffer lines after replay if other clients also need them.

The current integration is a Custom GPT Action. An MCP plugin needs an additional adapter and OAuth discovery before ChatGPT can connect through that surface.
