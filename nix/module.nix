{ self }:
{ config, lib, pkgs, ... }:
let
  inherit (lib) mkEnableOption mkIf mkOption types;
  cfg = config.services.zircon;
  settings = cfg.settings;
in {
  options.services.zircon = {
    enable = mkEnableOption "Zircon ChatGPT to IRC bridge";
    package = mkOption {
      type = types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "Zircon package to run.";
    };
    port = mkOption {
      type = types.port;
      default = 3000;
      description = "Loopback HTTP port for the reverse proxy.";
    };
    maxUsers = mkOption { type = types.ints.between 1 100; default = 16; description = "Maximum enabled ZNC user accounts created through Zircon."; };
    historyRetentionDays = mkOption { type = types.ints.between 1 365; default = 7; description = "Days to retain channel activity in SQLite."; };
    historyMaxPerChannel = mkOption { type = types.ints.between 100 100000; default = 5000; description = "Maximum retained activities per user and channel."; };
    enableDiagnostics = mkOption { type = types.bool; default = false; description = "Enable the authenticated /admin/events diagnostic API and bounded MCP request logging."; };
    environmentFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = "Absolute path outside the Nix store with ZNC_ADMIN_PASSWORD, ZNC_USER_SECRET, GITHUB_CLIENT_SECRET, OAUTH_CLIENT_SECRET, SESSION_SECRET and ADMIN_TOKEN.";
    };
    settings = mkOption {
      description = "Non-secret Zircon configuration.";
      default = {};
      type = types.submodule { options = {
        publicBaseUrl = mkOption { type = types.str; default = "https://zircon.chooser.us"; };
        githubClientId = mkOption { type = types.str; default = ""; };
        oauthClientId = mkOption { type = types.str; default = "zircon-chatgpt"; };
        oauthRedirectUris = mkOption { type = types.listOf types.str; default = []; };
        zncPort = mkOption { type = types.port; default = 6667; };
        zncAdminUser = mkOption { type = types.str; default = "zirconctl"; };
        ircNetworks = mkOption {
          type = types.listOf (types.submodule { options = {
            name = mkOption { type = types.str; };
            host = mkOption { type = types.str; };
            port = mkOption { type = types.port; };
            tls = mkOption { type = types.bool; default = true; };
          }; });
          default = [ { name = "chonkbase"; host = "irc.chonkbase.net"; port = 6697; tls = true; } ];
          description = "Owner-approved IRC networks users may select.";
        };
        ircUsername = mkOption { type = types.str; default = "zircon"; };
        ircRealname = mkOption { type = types.str; default = "Zircon ChatGPT bridge"; };
        ircChannels = mkOption { type = types.listOf types.str; default = []; };
        diagnosticsAdminLogins = mkOption { type = types.listOf types.str; default = []; description = "GitHub logins permitted to view diagnostics with a signed-in browser session."; };
      }; };
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      { assertion = cfg.environmentFile != null && !(lib.hasPrefix "/nix/store/" (toString cfg.environmentFile));
        message = "services.zircon.environmentFile must be an absolute path outside /nix/store"; }
      { assertion = settings.githubClientId != "" && settings.ircChannels != [] && settings.ircNetworks != [];
        message = "services.zircon.settings requires githubClientId, ircChannels, and ircNetworks"; }
    ];

    systemd.services.zircon = {
      description = "Zircon ChatGPT to IRC bridge";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" "znc.service" ];
      wants = [ "network-online.target" ];
      environment = {
        PORT = toString cfg.port;
        MAX_USERS = toString cfg.maxUsers;
        HISTORY_RETENTION_DAYS = toString cfg.historyRetentionDays;
        HISTORY_MAX_PER_CHANNEL = toString cfg.historyMaxPerChannel;
        DIAGNOSTICS_ENABLED = lib.boolToString cfg.enableDiagnostics;
        DIAGNOSTICS_ADMIN_LOGINS = lib.concatStringsSep "," settings.diagnosticsAdminLogins;
        PUBLIC_BASE_URL = settings.publicBaseUrl;
        GITHUB_CLIENT_ID = settings.githubClientId;
        OAUTH_CLIENT_ID = settings.oauthClientId;
        OAUTH_REDIRECT_URIS = lib.concatStringsSep "," settings.oauthRedirectUris;
        STATE_DIR = "/var/lib/zircon";
        ZNC_HOST = "127.0.0.1";
        ZNC_PORT = toString settings.zncPort;
        ZNC_ADMIN_USER = settings.zncAdminUser;
        IRC_NETWORKS_JSON = builtins.toJSON settings.ircNetworks;
        IRC_USERNAME = settings.ircUsername;
        IRC_REALNAME = settings.ircRealname;
        IRC_CHANNELS = lib.concatStringsSep "," settings.ircChannels;
      };
      serviceConfig = {
        Type = "simple";
        ExecStart = "${cfg.package}/bin/zircon";
        EnvironmentFile = lib.optional (cfg.environmentFile != null) cfg.environmentFile;
        Restart = "on-failure";
        RestartSec = 5;
        DynamicUser = true;
        StateDirectory = "zircon";
        UMask = "0077";
        WorkingDirectory = "/var/lib/zircon";
        ProtectSystem = "strict";
        ProtectHome = true;
        NoNewPrivileges = true;
        PrivateTmp = true;
        CapabilityBoundingSet = "";
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
      };
    };
  };
}
