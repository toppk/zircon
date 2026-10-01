{ stdenvNoCC, makeWrapper, bun, self }:
stdenvNoCC.mkDerivation {
  pname = "zircon";
  version = "0.2.0";
  src = self;
  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/zircon" "$out/bin"
    cp -r src "$out/lib/zircon/"
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
