# Installed-package compatibility smoke

`npm run smoke:installed` packs this workspace package, installs the tarball and the exact Pi 0.84.3 peers into an isolated package tree, installs the actual npm Pi CLI separately, and gives the process a fresh `PI_CODING_AGENT_DIR`.

The RPC process is launched with the extension-owned `--roster-name` flag. The fixture queries registered commands and invokes `/roster-status`; its response confirms that Pi loaded the extension, parsed the flag, and exposed the TypeBox-backed `roster_noop` tool.

This is the compatibility gate for [Pi issue #8620](https://github.com/earendil-works/pi/issues/8620), which remains open for installed CLI resolution of internal/deep paths. The exact 0.84.3 npm CLI passes this fixture because the extension uses public-root imports only. A failure is a publishing blocker: do not replace the npm CLI with an unbundled development entrypoint to make this check pass.
