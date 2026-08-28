{
  description = "Development environments for pi-mono";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    nixpkgs,
    flake-utils,
    ...
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = import nixpkgs {inherit system;};
        inherit (pkgs) lib;

        npmVersion = "12.0.2";
        npmTarball = pkgs.fetchurl {
          url = "https://registry.npmjs.org/npm/-/npm-${npmVersion}.tgz";
          hash = "sha512-uIXokLlBj6FpNUTQX1PmT5pz7BlIN9QlixX+zdaSNHsd0qUXsbDLr50xzY6Sw7cJVr0uzHKDOle0swmPW/p5Qw==";
        };
        npmPackage = pkgs.stdenvNoCC.mkDerivation {
          pname = "npm";
          version = npmVersion;
          src = npmTarball;
          sourceRoot = "package";
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            mkdir -p "$out/lib/node_modules/npm"
            cp -R . "$out/lib/node_modules/npm"
            runHook postInstall
          '';
        };

        node24 = pkgs.nodejs-slim_24;
        node22 = pkgs.nodejs-slim_22;
        supportsNode = node: major: floor:
          lib.versions.major node.version == major
          && lib.versionAtLeast node.version floor;
        node24Supported = supportsNode node24 "24" "24.15.0";
        node22Supported = supportsNode node22 "22" "22.22.2";

        npmFor = node:
          pkgs.writeShellScriptBin "npm" ''
            exec ${node}/bin/node ${npmPackage}/lib/node_modules/npm/bin/npm-cli.js "$@"
          '';
        npm24 = npmFor node24;
        npm22 = npmFor node22;

        mkNodeShell = node: npm:
          pkgs.mkShell {
            packages = [node npm pkgs.git];
          };

        mkToolchainCheck = {
          name,
          node,
          npm,
          major,
          floor,
        }:
          pkgs.runCommand name {} ''
            ${node}/bin/node -e '
              const current = process.versions.node.split(".").map(Number);
              const floor = process.argv[1].split(".").map(Number);
              const major = Number(process.argv[2]);
              const firstDifference = current.findIndex((part, index) => part !== floor[index]);
              const atLeastFloor = firstDifference === -1
                || current[firstDifference] > floor[firstDifference];
              if (current[0] !== major || !atLeastFloor) process.exit(1);
            ' ${lib.escapeShellArg floor} ${lib.escapeShellArg major}
            test "$(${npm}/bin/npm --version)" = ${lib.escapeShellArg npmVersion}
            touch "$out"
          '';
      in
        assert lib.assertMsg node24Supported
        "npm ${npmVersion} requires Node 24 >= 24.15.0, but nixpkgs provides ${node24.version} on ${system}";
        assert lib.assertMsg node22Supported
        "npm ${npmVersion} requires Node 22 >= 22.22.2, but nixpkgs provides ${node22.version} on ${system}";
        {
          devShells = {
            default = mkNodeShell node24 npm24;
            ci = mkNodeShell node22 npm22;
          };

          checks = {
            node-24-toolchain = mkToolchainCheck {
              name = "node-24-toolchain";
              node = node24;
              npm = npm24;
              major = "24";
              floor = "24.15.0";
            };
            node-22-toolchain = mkToolchainCheck {
              name = "node-22-toolchain";
              node = node22;
              npm = npm22;
              major = "22";
              floor = "22.22.2";
            };
          };
        }
    );
}
