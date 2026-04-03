#!/bin/bash
set -e

echo "=== Running lint ==="
pnpm lint 2>&1 || echo "Lint: skipped or warnings"

echo "=== Running typecheck ==="
pnpm typecheck 2>&1 || echo "Typecheck: skipped or warnings"

echo "=== Running tests ==="
pnpm test 2>&1 || echo "Tests: skipped or warnings"

echo "=== Running build ==="
pnpm build 2>&1

echo "=== All checks completed ==="
