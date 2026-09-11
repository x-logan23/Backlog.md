#!/usr/bin/env bash
#
# Recompile this fork and install the resulting standalone binary over the
# global `backlog` command in ~/.bun/bin, so the `backlog` on your PATH
# reflects your local changes.
#
# Usage (from anywhere; the script cd's to the repo root itself):
#   bash scripts/install-local.sh
#   # or via the package.json alias:
#   bun run install:local
#
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$repo_dir"

echo "==> Building (build:css + compile)…"
bun run build

# Locate the compiled binary. Bun appends .exe on Windows; plain name on POSIX.
if [ -f "dist/backlog.exe" ]; then
	src="dist/backlog.exe"
	dest="$HOME/.bun/bin/backlog.exe"
elif [ -f "dist/backlog" ]; then
	src="dist/backlog"
	dest="$HOME/.bun/bin/backlog"
else
	echo "error: no compiled binary found in dist/ — did 'bun run build' succeed?" >&2
	exit 1
fi

# Stop any running backlog process so the copy doesn't hit a Windows file
# lock (browser/watch/MCP all run as 'backlog'). Best-effort; ignored on
# POSIX or when nothing is running.
if command -v powershell >/dev/null 2>&1; then
	powershell -NoProfile -Command "Get-Process backlog -ErrorAction SilentlyContinue | Stop-Process -Force" >/dev/null 2>&1 || true
fi

mkdir -p "$(dirname "$dest")"
# Remove before copying, rather than overwriting in place.
#
# On macOS a Bun-compiled binary carries an ad-hoc code signature, and writing
# new bytes over a path the kernel has already seen invalidates it against the
# cached identity: the result is killed by SIGKILL the moment it runs, printing
# "Killed: 9" and nothing else. Replacing the inode sidesteps that entirely.
rm -f "$dest"
cp "$src" "$dest"

# Re-sign ad-hoc on macOS. `cp` does preserve the signature, but a freshly
# written binary at a previously-signed path can still be rejected; signing
# again is cheap and makes the outcome deterministic.
if [ "$(uname -s)" = "Darwin" ] && command -v codesign >/dev/null 2>&1; then
	codesign --force --sign - "$dest" >/dev/null 2>&1 || true
fi

echo "==> Installed: $src -> $dest"

# Verify, and fail loudly if it does not run.
#
# This used to be `"$dest" --version >/dev/null && echo ...`, which printed
# nothing at all when the binary was killed and still exited 0 -- so a broken
# install looked like a successful one, and the next command to fail was
# whatever the user ran minutes later.
if ! installed_version="$("$dest" --version 2>&1)"; then
	echo "error: the installed binary at $dest does not run:" >&2
	echo "  $installed_version" >&2
	echo "  On macOS a 'Killed: 9' here means the code signature was rejected." >&2
	exit 1
fi
echo "==> backlog --version: $installed_version"
echo "==> Done. Restart any running 'backlog browser/watch' and start a fresh"
echo "    Claude Code session if you want the MCP server to pick up the new build."
