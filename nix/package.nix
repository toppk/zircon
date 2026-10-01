{ stdenvNoCC, runCommand, fetchurl, makeWrapper, bun, self }:
let
  # Keep this version and integrity hash in sync with bun.lock.
  joseTarball = fetchurl {
    url = "https://registry.npmjs.org/jose/-/jose-6.2.12.tgz";
    hash = "sha512-9NiFmJEex0sy2Dk58j2UGBSHgUs2ypF9eZSu4L6vjOX3Dp96Sw1F3uL+H+D1sx02jZZdzUT0HgvCy59CuvXcWw==";
  };
  nodeModules = runCommand "zircon-node-modules" {
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    outputHash = "sha256-jolVgI5eCjrRlCaPV6YE1/E+z1WMhpiNWeRrhnZbs1A=";
  } ''
    mkdir -p "$out/node_modules/jose"
    tar -xzf ${joseTarball} -C "$out/node_modules/jose" --strip-components=1
  '';
in
stdenvNoCC.mkDerivation {
  pname = "zircon";
  version = "0.1.0";
  src = self;
  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/zircon" "$out/bin"
    cp -r src "$out/lib/zircon/"
    cp -r ${nodeModules}/node_modules "$out/lib/zircon/"
    makeWrapper ${bun}/bin/bun "$out/bin/zircon" \
      --add-flags "run $out/lib/zircon/src/index.js"
    runHook postInstall
  '';
  meta = {
    description = "Authenticated ChatGPT bridge to a local ZNC bouncer";
    mainProgram = "zircon";
    platforms = [ "x86_64-linux" ];
  };
}
