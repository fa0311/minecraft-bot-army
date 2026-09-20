#!/bin/sh
# Re-apply the movement/physics patches to node_modules.
# Run this after every `npm install` / `npm ci` in /root/workspace/bots.
#   sh /root/workspace/bots/patches/apply.sh
# Idempotent: already-applied patches are skipped (patch --forward).
set -e
cd "$(dirname "$0")/.."   # -> /root/workspace/bots

fail=0
for p in patches/*.patch; do
  target=$(head -1 "$p" | sed 's/^--- patches\/orig\///')
  case "$target" in
    prismarine-physics.index.js*)          file=node_modules/prismarine-physics/index.js ;;
    mineflayer.lib.plugins.physics.js*)    file=node_modules/mineflayer/lib/plugins/physics.js ;;
    prismarine-physics.lib.aabb.js*)       file=node_modules/prismarine-physics/lib/aabb.js ;;
    *) echo "!! unknown target in $p"; fail=1; continue ;;
  esac
  if patch --forward --silent --dry-run "$file" < "$p" >/dev/null 2>&1; then
    patch "$file" < "$p" >/dev/null && echo "applied  $p -> $file"
  else
    if grep -q "PATCHED" "$file"; then echo "already  $p -> $file"
    else echo "!! FAILED $p -> $file"; fail=1; fi
  fi
done
exit $fail
