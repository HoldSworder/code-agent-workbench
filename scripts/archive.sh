#!/bin/bash
set -e

if [ -n "${OPENSPEC_PATH}" ]; then
  git add "${OPENSPEC_PATH}"
  git commit -m "chore: archive openspec for $(basename ${OPENSPEC_PATH})" || echo "Nothing to commit"
fi

echo "Archive completed"
