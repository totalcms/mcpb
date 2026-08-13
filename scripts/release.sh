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
# DISABLED BY DEFAULT — mcpb 2.1.x signing produces a bundle Claude Desktop
# refuses to install. `sign` appends the signature as a trailer AFTER the zip's
# end-of-central-directory record (the file ends with a literal MCPB_SIG_END
# marker). Lenient readers (unzip, python zipfile) skip trailing bytes and call
# the archive fine, but Claude Desktop's stricter parser rejects it:
#
#   Failed to preview extension: Invalid comment length. Expected: 2264.
#   Found: 0. Are there extra bytes at the end of the file?
#
# 2264 is exactly the number of bytes sign added. The tool's own `verify` and
# `info` also report "not signed" on files it just signed. Reproduced on 2.1.1
# and 2.1.2, with --self-signed and with an openssl-generated cert/key.
#
# Set MCPB_SIGN=1 to sign anyway once upstream is fixed.
if [ "${MCPB_SIGN:-0}" != "1" ]; then
	echo "    skipped — mcpb 2.1.x signing corrupts the bundle for Claude Desktop"
	echo "    (set MCPB_SIGN=1 to override; see the comment in this script)"
elif [ -n "${MCPB_CERT:-}" ] && [ -n "${MCPB_KEY:-}" ]; then
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
echo "==> Checking the archive is clean"
# The failure mode we care about is trailing bytes after the zip's
# end-of-central-directory record — that is what breaks installation. Assert
# the file ends with the EOCD (no signature trailer) so a corrupt bundle can
# never reach the submission form.
#
# -a is load-bearing: the input is 32 raw bytes containing NULs, and BSD grep
# (macOS) classifies that as binary and exits 1 even when the pattern MATCHES.
# Without it this guard silently passes on exactly the corrupt bundle it exists
# to catch — verified against a signed bundle whose final bytes are literally
# MCPB_SIG_END.
if tail -c 32 "$BUNDLE" | grep -qa "MCPB_SIG_END"; then
	echo "    ERROR: bundle carries an appended signature trailer." >&2
	echo "    Claude Desktop will refuse to install it. Rebuild without signing." >&2
	exit 1
fi
echo "    no signature trailer — installable"

echo
echo "==> Done: $BUNDLE ($(du -h "$BUNDLE" | cut -f1))"
