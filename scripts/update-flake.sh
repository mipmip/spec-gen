#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

FLAKE="flake.nix"
PKG="package.json"
LOCK="package-lock.json"

if [[ ! -f "$FLAKE" ]]; then echo "Error: $FLAKE not found"; exit 1; fi
if [[ ! -f "$PKG" ]]; then echo "Error: $PKG not found"; exit 1; fi

# --- Version sync ---
new_version=$(jq -r .version "$PKG")
old_version=$(sed -n 's/.*version = "\([^"]*\)".*/\1/p' "$FLAKE")

if [[ "$old_version" == "$new_version" ]]; then
  echo "Version already in sync: $new_version"
else
  sed -i "s/version = \"$old_version\"/version = \"$new_version\"/" "$FLAKE"
  echo "Version: $old_version → $new_version"
fi

# --- Ensure lockfile is in sync ---
echo "Syncing package-lock.json..."
npm install --package-lock-only --ignore-scripts --silent 2>/dev/null

# --- Compute npmDepsHash ---
# Use nix build with a dummy hash to get the correct hash from the error.
# This is the only reliable method when npmDepsFetcherVersion = 2 is used,
# because prefetch-npm-deps computes a v1 hash that won't match.
echo "Computing npmDepsHash (this may take a moment)..."

old_hash=$(sed -n 's/.*npmDepsHash = "\([^"]*\)".*/\1/p' "$FLAKE")
dummy_hash="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

# Temporarily set a dummy hash to force a mismatch
sed -i "s|npmDepsHash = \"$old_hash\"|npmDepsHash = \"$dummy_hash\"|" "$FLAKE"

# Build and capture the correct hash from the error message
build_output=$(nix build . 2>&1 || true)
new_hash=$(echo "$build_output" | sed -n 's/.*got: *//p')

if [[ -z "$new_hash" ]]; then
  # Restore original hash on failure
  sed -i "s|npmDepsHash = \"$dummy_hash\"|npmDepsHash = \"$old_hash\"|" "$FLAKE"
  echo "Error: could not determine npmDepsHash from nix build output"
  echo "$build_output"
  exit 1
fi

# Set the correct hash
sed -i "s|npmDepsHash = \"$dummy_hash\"|npmDepsHash = \"$new_hash\"|" "$FLAKE"

if [[ "$old_hash" == "$new_hash" ]]; then
  echo "npmDepsHash unchanged: $new_hash"
else
  echo "npmDepsHash: $old_hash → $new_hash"
fi

echo ""
echo "Done. Review changes with: git diff flake.nix"
