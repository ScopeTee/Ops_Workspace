#!/bin/bash
# Vercel "Ignored Build Step" helper for a monorepo with two independent
# app projects. Exit 0 = skip this project's deploy, exit 1 = build it.
#
# Usage (set as the Ignored Build Step command in each Vercel project):
#   bash ../../scripts/vercel-ignore.sh apps/shipment packages/shared scripts
set -e

if [ -z "$VERCEL_GIT_PREVIOUS_SHA" ]; then
  echo "No previous deployment SHA on record — building."
  exit 1
fi

if git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" "$VERCEL_GIT_COMMIT_SHA" -- "$@"; then
  echo "No relevant changes in: $* — skipping this deploy."
  exit 0
else
  echo "Relevant changes detected in: $* — building."
  exit 1
fi
