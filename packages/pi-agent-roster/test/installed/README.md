# Installed-package compatibility smoke

`npm run smoke:installed` packs this workspace package, installs the tarball and the exact Pi 0.84.3 peers into an isolated package tree, installs the actual npm Pi CLI separately, and gives the process a fresh `PI_CODING_AGENT_DIR`.

The RPC process is launched with the extension-owned `--agent` and `--stack` flags to exercise installed primary selection.

The fixture then uses Pi's SDK with its deterministic faux provider to run the packed extension in-process. It covers foreground tool execution, service foreground/background execution, delayed queue admission, workspace tools, steering, retained and reconstructed resume, child JSONL isolation, lifecycle events, retention release, and parent/child shutdown without network access or credentials.

This is the compatibility gate for [Pi issue #8620](https://github.com/earendil-works/pi/issues/8620), which remains open for installed CLI resolution of internal/deep paths. The exact 0.84.3 npm CLI passes this fixture because the extension uses public-root imports only. A failure is a publishing blocker: do not replace the npm CLI with an unbundled development entrypoint to make this check pass.
