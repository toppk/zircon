{
  description = "Zircon ChatGPT to IRC bridge";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      moduleTest = nixpkgs.lib.nixosSystem {
        inherit system;
        modules = [
          self.nixosModules.default
          {
            system.stateVersion = "26.05";
            services.zircon = {
              enable = true;
              environmentFile = "/run/secrets/zircon.env";
              settings = {
                githubClientId = "test-github-id";
                oauthRedirectUris = [ "https://chatgpt.com/aip/g-example/oauth/callback" ];
                ircChannels = [ "#lobby" "#soup" ];
              };
            };
          }
        ];
      };
    in {
      packages.${system}.default = pkgs.callPackage ./nix/package.nix { inherit self; };
      nixosModules.default = import ./nix/module.nix { inherit self; };
      checks.${system} = {
        default = self.packages.${system}.default;
        module = pkgs.runCommand "zircon-module-check" {} ''
          test "${moduleTest.config.systemd.services.zircon.serviceConfig.ExecStart}" = "${self.packages.${system}.default}/bin/zircon"
          test "${moduleTest.config.systemd.services.zircon.environment.ZNC_HOST}" = "127.0.0.1"
          test "${builtins.head moduleTest.config.systemd.services.zircon.serviceConfig.EnvironmentFile}" = "/run/secrets/zircon.env"
          test "${toString moduleTest.config.systemd.services.zircon.serviceConfig.DynamicUser}" = "1"
          test "${moduleTest.config.systemd.services.zircon.serviceConfig.StateDirectory}" = "zircon"
          touch "$out"
        '';
      };
    };
}
