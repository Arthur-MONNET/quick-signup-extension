#!/bin/bash
# Brings ~/QuickSignup to the latest version of the stable branch. Run daily by launchd (see install.sh), or by hand.
# The extension notices the new version on disk and reloads itself when no sign-up is running.
set -uo pipefail

REPO="Arthur-MONNET/quick-signup-extension"
BRANCH="stable"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DIR/manifest.json" | head -1; }

BEFORE=$(version)
echo "[$(date '+%F %T')] checking for updates (current $BEFORE)"
if [ -d "$DIR/.git" ] && command -v git >/dev/null 2>&1; then
    # The folder is a copy to run, never edited: local changes are dropped.
    git -C "$DIR" fetch --quiet --depth 1 origin "$BRANCH" || { echo "offline or GitHub unreachable: will try again later"; exit 0; }
    git -C "$DIR" reset --quiet --hard FETCH_HEAD
else
    TMP=$(mktemp -d)
    if curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz --strip-components 1 -C "$TMP"; then
        rsync -a --delete "$TMP/" "$DIR/"
    else
        echo "offline or GitHub unreachable: will try again later"
    fi
    rm -rf "$TMP"
fi
AFTER=$(version)
if [ "$BEFORE" = "$AFTER" ]; then echo "up to date ($AFTER)"; else echo "updated $BEFORE -> $AFTER"; fi
