args@{ inputs ? { }, pkgs, system ? pkgs.system, ... }:

let
  piPackage = args.piPackage or (if inputs ? pi then inputs.pi.packages.${system}.pi else null);
  piPassthru = if piPackage != null && piPackage ? passthru then piPackage.passthru else { };
  nodejs = if piPassthru ? nodejs then piPassthru.nodejs else pkgs.nodejs_24;
  runtimePackages = if piPassthru ? runtimePackages then piPassthru.runtimePackages else [ ];
in

{
  # https://devenv.sh/reference/options/
  languages.javascript = {
    enable = true;
    package = nodejs;
    npm = {
      enable = true;
      install.enable = true;
    };
  };

  packages = runtimePackages ++ [
    pkgs.sqlite
  ];

  scripts.pi-baker-check.exec = ''
    npm run typecheck
    npm test
  '';

  enterTest = ''
    pi-baker-check
  '';
}
