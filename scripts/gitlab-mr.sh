#!/bin/bash
set -e

TARGET_BRANCH="develop"
AUTO_MERGE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --target) TARGET_BRANCH="$2"; shift 2 ;;
    --auto-merge) AUTO_MERGE="--auto-merge"; shift ;;
    *) shift ;;
  esac
done

CURRENT_BRANCH=$(git branch --show-current)
echo "Creating MR: ${CURRENT_BRANCH} → ${TARGET_BRANCH}"

git push -u origin "${CURRENT_BRANCH}"

if command -v glab &> /dev/null; then
  glab mr create \
    --source-branch "${CURRENT_BRANCH}" \
    --target-branch "${TARGET_BRANCH}" \
    --title "${CURRENT_BRANCH}" \
    --fill \
    ${AUTO_MERGE}
  echo "MR created successfully"
else
  echo "glab not found. Please create MR manually."
  echo "Source: ${CURRENT_BRANCH}"
  echo "Target: ${TARGET_BRANCH}"
fi
