#!/bin/bash
# Removes the daily update job and ~/QuickSignup. Then remove the extension from the browser's extensions page.
set -uo pipefail
LABEL="com.quicksignup.update"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
rm -rf "$HOME/QuickSignup"
echo "Quick Signup removed. Also click « Remove » on it in your browser's extensions page."
