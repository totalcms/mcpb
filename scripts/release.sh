#!/usr/bin/env bash
#
# Build, sign, and verify the Total CMS desktop extension.
#
#   npm run release                 # sign with a self-signed certificate
#   MCPB_CERT=… MCPB_KEY=… npm run release   # sign with a real certificate
#
# Signing is deliberately NOT part of `npm run build`: build runs constantly
# during development, signing is a release step. Certificate material stays out
# of git (see .gitignore) — never commit cert.pem or key.pem.
set -euo pipefail

cd "$(dirname "$0")/.."

BUNDLE="dist/totalcms.mcpb"

# `command` forces a PATH lookup, skipping any shell function or alias named
# npx. Some environments (nvm's lazy-loading wrappers, tool shell snapshots)
# shadow npx with a function that swallows the arguments and prints nvm's help
# instead of running anything.
MCPB=(command npx --yes @anthropic-ai/mcpb)

echo "==> Building"
npm run build

if [ ! -f "$BUNDLE" ]; then
	echo "error: $BUNDLE was not produced by the build" >&2
	exit 1
fi

echo
echo "==> Signing"
if [ -n "${MCPB_CERT:-}" ] && [ -n "${MCPB_KEY:-}" ]; then
	echo "    certificate: $MCPB_CERT"
	"${MCPB[@]}" sign "$BUNDLE" --cert "$MCPB_CERT" --key "$MCPB_KEY" \
		${MCPB_INTERMEDIATE:+--intermediate $MCPB_INTERMEDIATE}
elif [ -n "${MCPB_CERT:-}" ] || [ -n "${MCPB_KEY:-}" ]; then
	echo "error: set BOTH MCPB_CERT and MCPB_KEY, or neither (for --self-signed)" >&2
	exit 1
else
	echo "    no MCPB_CERT/MCPB_KEY set — using a self-signed certificate"
	echo "    (users and reviewers will see a self-signed warning)"
	"${MCPB[@]}" sign "$BUNDLE" --self-signed
fi

echo
echo "==> Verifying"
# Informational only. As of mcpb 2.1.1/2.1.2, `sign` reports success and grows
# the bundle by ~2.3KB (a signature IS written) while `verify` and `info` both
# report "not signed" — reproduced with --self-signed AND with a real
# openssl-generated cert/key pair, so it is not specific to this bundle or to
# the self-signed path. Treat a failure here as a warning rather than aborting
# the release; confirm the signature in Claude Desktop at install time.
if ! "${MCPB[@]}" verify "$BUNDLE"; then
	echo
	echo "    WARNING: verify could not confirm the signature."
	echo "    Known mcpb 2.1.x sign/verify mismatch — check the installed"
	echo "    extension in Claude Desktop before relying on this."
fi

echo
echo "==> Done: $BUNDLE ($(du -h "$BUNDLE" | cut -f1))"
