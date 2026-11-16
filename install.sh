#!/usr/bin/env bash
# Symlink the applet into ~/.local/share/cinnamon/applets (changes in the repo take effect directly).
set -euo pipefail
UUID="glw@martin"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="$HOME/.local/share/cinnamon/applets/$UUID"
mkdir -p "$(dirname "$DEST")"
if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
  echo "$DEST already exists and is not a symlink – please check manually." >&2; exit 1
fi
ln -sfn "$SRC" "$DEST"
echo "Installed: $DEST -> $SRC"
echo "Next: right-click the panel → Applets → add 'GitLab Pipeline Watch'."
echo "Reload after code changes:"
echo "  dbus-send --session --dest=org.Cinnamon.LookingGlass --type=method_call /org/Cinnamon/LookingGlass org.Cinnamon.LookingGlass.ReloadExtension string:'$UUID' string:'APPLET'"
