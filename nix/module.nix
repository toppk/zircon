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
    environmentFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = "Absolute path outside the Nix store with ZNC_PASSWORD as KEY=value; never put secrets in Nix settings.";
    };
    settings = mkOption {
      description = "Non-secret Zircon configuration.";
      default = {};
      type = types.submodule { options = {
        publicBaseUrl = mkOption { type = types.str; default = "https://zircon.chooser.us"; };
        oidcIssuer = mkOption { type = types.nullOr types.str; default = null; };
        oidcAudience = mkOption { type = types.str; default = "https://zircon.chooser.us"; };
        oidcJwksUrl = mkOption { type = types.nullOr types.str; default = null; };
        allowedSubjects = mkOption { type = types.listOf types.str; default = []; };
        zncPort = mkOption { type = types.port; default = 6667; };
        zncUser = mkOption { type = types.str; default = "zircon"; };
        zncNetwork = mkOption { type = types.nullOr types.str; default = null; };
        ircNick = mkOption { type = types.str; default = "zircon"; };
        ircUsername = mkOption { type = types.str; default = "zircon"; };
        ircRealname = mkOption { type = types.str; default = "Zircon ChatGPT bridge"; };
        ircChannels = mkOption { type = types.listOf types.str; default = []; };
      }; };
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      { assertion = cfg.environmentFile != null && !(lib.hasPrefix "/nix/store/" (toString cfg.environmentFile));
        message = "services.zircon.environmentFile must be an absolute path outside /nix/store"; }
      { assertion = settings.oidcIssuer != null && settings.oidcJwksUrl != null && settings.zncNetwork != null;
        message = "services.zircon.settings requires oidcIssuer, oidcJwksUrl, and zncNetwork"; }
      { assertion = settings.allowedSubjects != [] && settings.ircChannels != [];
        message = "services.zircon.settings requires allowedSubjects and ircChannels"; }
    ];

    systemd.services.zircon = {
      description = "Zircon ChatGPT to IRC bridge";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" "znc.service" ];
      wants = [ "network-online.target" ];
      environment = {
        PORT = toString cfg.port;
        PUBLIC_BASE_URL = settings.publicBaseUrl;
        OIDC_ISSUER = if settings.oidcIssuer == null then "" else settings.oidcIssuer;
        OIDC_AUDIENCE = settings.oidcAudience;
        OIDC_JWKS_URL = if settings.oidcJwksUrl == null then "" else settings.oidcJwksUrl;
        OIDC_ALLOWED_SUBJECTS = lib.concatStringsSep "," settings.allowedSubjects;
        ZNC_HOST = "127.0.0.1";
        ZNC_PORT = toString settings.zncPort;
        ZNC_USER = settings.zncUser;
        ZNC_NETWORK = if settings.zncNetwork == null then "" else settings.zncNetwork;
        IRC_NICK = settings.ircNick;
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
