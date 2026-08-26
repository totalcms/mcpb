#!/usr/bin/env bash
#
# Set the release version everywhere it appears.
#
#   npm run bump 0.3.0
#
# The version lives in four files, and one of them — the USER_AGENT constant
# in src/index.ts — gets compiled into the shipped bundle, so a partial bump
# ships a binary that misreports itself. The release workflow refuses to build
# when they disagree; this is how you keep them agreeing.
set -euo pipefail

cd "$(dirname "$0")/.."

NEW="${1:-}"
if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "usage: npm run bump <major.minor.patch>    e.g. npm run bump 0.3.0" >&2
	exit 1
fi

python3 - "$NEW" <<'PY'
import io, json, re, sys

new = sys.argv[1]
old = json.load(io.open("package.json", encoding="utf-8"))["version"]
if old == new:
    print(f"already at {new} — nothing to do")
    raise SystemExit(0)

# Targeted string replacement rather than json.dump: these files are
# tab-indented and hand-maintained, and a reserializing edit would reformat
# the whole file and bury the one-line change in noise.
edits = {
    "package.json":  [(f'"version": "{old}"', f'"version": "{new}"')],
    "manifest.json": [(f'"version": "{old}"', f'"version": "{new}"')],
    "src/index.ts":  [(f'"totalcms-mcpb/{old}"', f'"totalcms-mcpb/{new}"')],
    "server.json":   [(f'"version": "{old}"', f'"version": "{new}"'),
                      (f"releases/download/v{old}/", f"releases/download/v{new}/")],
}

for path, pairs in edits.items():
    s = io.open(path, encoding="utf-8").read()
    for a, b in pairs:
        if s.count(a) != 1:
            raise SystemExit(f"error: {path}: expected exactly one {a!r}, found {s.count(a)}")
        s = s.replace(a, b)
    io.open(path, "w", encoding="utf-8").write(s)
    print(f"  {path}")

print(f"\n{old} -> {new}")
print("\nNext:")
print(f'  add a "## [{new}] - <today>" section to CHANGELOG.md — it becomes the release notes')
print(f'  git commit -am "Release v{new}"')
print(f"  git tag v{new} && git push origin master v{new}")
print("\nThe Release workflow builds, publishes the GitHub release, and updates")
print("the MCP Registry. fileSha256 is stamped there — no need to touch it.")
PY
