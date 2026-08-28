# Pi plugins

A small npm-workspace monorepo for Pi extensions. The first package is
[`pi-agent-roster`](./packages/pi-agent-roster/README.md).

## Development

Use Node 24 by default:

```sh
nix develop
npm ci
npm run verify:all
```

The Node 22 compatibility shell uses the same locked Nixpkgs revision:

```sh
nix develop .#ci
npm ci
npm run verify:all
```

Both shells provide Node, the fixed-output npm 12.0.2 wrapper, and Git. The flake does
not install dependencies or mutate package-manager state when a shell is entered.
