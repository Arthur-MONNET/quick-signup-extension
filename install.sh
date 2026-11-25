#!/bin/bash
# Quick Signup installer (macOS). Usage:
#   curl -fsSL https://raw.githubusercontent.com/Arthur-MONNET/quick-signup-extension/stable/install.sh | bash
# Installs the extension in ~/QuickSignup and a daily job that keeps it up to date. Safe to run again.
set -euo pipefail

REPO="Arthur-MONNET/quick-signup-extension"
BRANCH="stable"
DIR="$HOME/QuickSignup"
LABEL="com.quicksignup.update"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

# git only if it is really there: on a Mac without developer tools, /usr/bin/git opens an install dialog.
has_git() { command -v git >/dev/null 2>&1 && xcode-select -p >/dev/null 2>&1; }

if [ -d "$DIR" ]; then
    say "Quick Signup is already installed: updating it."
    bash "$DIR/scripts/update.sh"
else
    say "Downloading Quick Signup into $DIR…"
    if has_git; then
        git clone --quiet --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$DIR"
    else
        mkdir -p "$DIR"
        curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz --strip-components 1 -C "$DIR"
    fi
fi

# Daily update at 10:00, and at each login (a Mac asleep at 10:00 runs it when it wakes up).
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DIR/scripts/update.sh</string></array>
    <key>StartCalendarInterval</key><dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>$HOME/Library/Logs/QuickSignup.log</string>
    <key>StandardErrorPath</key><string>$HOME/Library/Logs/QuickSignup.log</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DIR/manifest.json" | head -1)
echo
say "✅ Quick Signup $VERSION is installed. It updates itself every day."
echo
echo "Last step, in your browser (Chrome, Dia, Arc, Brave…):"
echo "  1. Open the extensions page:  chrome://extensions"
echo "  2. Turn on « Developer mode » (top right)"
echo "  3. Click « Load unpacked » and choose the folder that just opened: QuickSignup"
echo
echo "Already loaded before? Nothing to do: it reloads itself."
open "$DIR" >/dev/null 2>&1 || true
