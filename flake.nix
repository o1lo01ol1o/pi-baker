{
  inputs = {
    nixpkgs.url = "github:cachix/devenv-nixpkgs/rolling";
    systems.url = "github:nix-systems/default";
    devenv.url = "github:cachix/devenv";
    devenv.inputs.nixpkgs.follows = "nixpkgs";
    pi.url = "github:o1lo01ol1o/pi/e53c0e57da14fc4fdd873382bba50952be0b3f34";
    pi.inputs.nixpkgs.follows = "nixpkgs";
    pi.inputs.systems.follows = "systems";
    pi.inputs.devenv.follows = "devenv";
  };

  nixConfig = {
    extra-trusted-public-keys = "devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=";
    extra-substituters = "https://devenv.cachix.org";
  };

  outputs = inputs @ { nixpkgs, systems, ... }:
    let
      forEachSystem = nixpkgs.lib.genAttrs (import systems);
      perSystem =
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          piPackage = inputs.pi.packages.${system}.pi;
          piPassthru = if piPackage ? passthru then piPackage.passthru else { };
          nodejs = if piPassthru ? nodejs then piPassthru.nodejs else pkgs.nodejs_24;
          runtimePackages = if piPassthru ? runtimePackages then piPassthru.runtimePackages else [ ];
        in
        {
          inherit nodejs piPackage pkgs runtimePackages;
        };
    in
    {
      devShells = forEachSystem
        (system:
          let
            env = perSystem system;
          in
          {
            default = env.pkgs.mkShell {
              packages = env.runtimePackages ++ [
                env.nodejs
                env.pkgs.sqlite
              ];
            };
          });

      checks = forEachSystem
        (system:
          let
            env = perSystem system;
            packageLock = env.pkgs.lib.importJSON ./package-lock.json;
            piCodingAgentLockKey = "node_modules/@earendil-works/pi-coding-agent";
            nestedPiAiLockKey = "${piCodingAgentLockKey}/node_modules/@earendil-works/pi-ai";
            nestedPiAgentCoreLockKey = "${piCodingAgentLockKey}/node_modules/@earendil-works/pi-agent-core";
            nestedPiTuiLockKey = "${piCodingAgentLockKey}/node_modules/@earendil-works/pi-tui";
            # The published pi-coding-agent tarball carries its own shrinkwrap, which makes
            # npm bypass this repo's Nix-patched lock and try the registry inside the sandbox.
            # The source override below removes that file, so its content no longer matches
            # the upstream npm integrity. The fetchurl hash still authenticates the tarball.
            packageLockForNix = packageLock // {
              packages = packageLock.packages // {
                ${piCodingAgentLockKey} =
                  builtins.removeAttrs packageLock.packages.${piCodingAgentLockKey} [
                    "hasShrinkwrap"
                    "integrity"
                  ];
                ${nestedPiAiLockKey} = packageLock.packages.${nestedPiAiLockKey} // {
                  integrity = packageLock.packages."node_modules/@earendil-works/pi-ai".integrity;
                };
                ${nestedPiAgentCoreLockKey} = packageLock.packages.${nestedPiAgentCoreLockKey} // {
                  integrity = "sha512-BF9WPhixIFjT6Kp3Iz3H6ugkU+4AWotM8py96XE5pIK0arJbQKMWbR+dXSWWDEmR5yc/aFQODnuyowOEzMGO7Q==";
                };
                ${nestedPiTuiLockKey} = packageLock.packages.${nestedPiTuiLockKey} // {
                  integrity =
                    if packageLock.packages ? "node_modules/@earendil-works/pi-tui"
                    then packageLock.packages."node_modules/@earendil-works/pi-tui".integrity
                    else "sha512-OvOAMIbXiC9OSse17YMiXIsI9AS5XM/ZV8N/k+UzdlRpPILDQYmLElevgGW92kkXR8qHBClIdzhCjuzlBGvphA==";
                };
              };
            };
            projectSource = env.pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = env.pkgs.lib.fileset.unions [
                ./package.json
                ./package-lock.json
                ./tsconfig.json
                ./tsconfig.base.json
                ./packages/extension/package.json
                ./packages/extension/src
                ./packages/extension/test
              ];
            };
            piCodingAgentSource = env.pkgs.runCommand "pi-coding-agent-0.80.2-npm-source"
              {
                src = env.pkgs.fetchurl {
                  url = "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.80.2.tgz";
                  hash = "sha512-m9v7OUit0s9LklWfh61ca/XY5INjUzjtYtNZwy3cNvyjOLk3IpBgghP8aAp0iH35rLaiRwuuWiJ8t88ODMWY+A==";
                };
                nativeBuildInputs = [
                  env.pkgs.gnutar
                  env.pkgs.gzip
                ];
              }
              ''
                mkdir package
                tar -xzf "$src" -C package --strip-components=1
                rm -f package/npm-shrinkwrap.json
                mkdir -p "$out"
                cp -R package/. "$out"/
              '';
          in
          {
            pi-baker = env.pkgs.buildNpmPackage {
              pname = "pi-baker";
              version = (builtins.fromJSON (builtins.readFile ./packages/extension/package.json)).version;
              src = projectSource;

              nodejs = env.nodejs;
              nativeBuildInputs = env.runtimePackages ++ [
                env.pkgs.sqlite
              ];

              npmDeps = env.pkgs.importNpmLock {
                npmRoot = ./.;
                packageLock = packageLockForNix;
                packageSourceOverrides = {
                  "node_modules/@earendil-works/pi-coding-agent" = piCodingAgentSource;
                };
              };
              npmConfigHook = env.pkgs.importNpmLock.npmConfigHook;

              npmFlags = [ "--ignore-scripts" ];
              dontNpmBuild = true;
              doCheck = true;
              checkPhase = ''
                runHook preCheck
                npm run typecheck
                npm test
                runHook postCheck
              '';

              installPhase = ''
                runHook preInstall
                mkdir -p "$out"
                printf "ok\n" > "$out/check"
                runHook postInstall
              '';
            };
          });
    };
}
