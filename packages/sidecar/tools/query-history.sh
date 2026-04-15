#!/usr/bin/env bash
# Provides progressive search over conversation history from other workflow phases.
# Part of the code-agent WorkflowTool system.
set -euo pipefail

DB_PATH=""
TASK_ID=""
CURRENT_PHASE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)       DB_PATH="$2"; shift 2 ;;
    --task)     TASK_ID="$2"; shift 2 ;;
    --phase)    CURRENT_PHASE="$2"; shift 2 ;;
    *)          break ;;
  esac
done

if [[ -z "$DB_PATH" || -z "$TASK_ID" || -z "$CURRENT_PHASE" ]]; then
  echo '{"error":"Missing required args: --db <path> --task <id> --phase <id>"}' >&2
  exit 1
fi

if ! command -v sqlite3 &>/dev/null; then
  echo '{"error":"sqlite3 CLI not found. Please install sqlite3."}' >&2
  exit 1
fi

cmd="${1:-help}"
shift 2>/dev/null || true

case "$cmd" in
  list)
    sqlite3 -json "$DB_PATH" "
      SELECT
        phase_id,
        COUNT(*) AS message_count,
        MIN(created_at) AS first_at,
        MAX(created_at) AS last_at,
        SUBSTR(
          (SELECT c2.content FROM conversation_messages c2
           WHERE c2.repo_task_id = '$TASK_ID'
             AND c2.phase_id = cm.phase_id
             AND c2.role = 'assistant'
           ORDER BY c2.created_at ASC LIMIT 1),
          1, 200
        ) AS first_assistant_summary
      FROM conversation_messages cm
      WHERE repo_task_id = '$TASK_ID'
        AND phase_id != '$CURRENT_PHASE'
        AND role IN ('user', 'assistant')
      GROUP BY phase_id
      ORDER BY MIN(created_at) ASC;
    "
    ;;

  get)
    PHASE_ID="${1:?Usage: get <phase-id> [limit] [offset]}"
    LIMIT="${2:-10}"
    OFFSET="${3:-0}"
    sqlite3 -json "$DB_PATH" "
      SELECT role, content, created_at
      FROM conversation_messages
      WHERE repo_task_id = '$TASK_ID'
        AND phase_id = '$PHASE_ID'
        AND role IN ('user', 'assistant')
      ORDER BY created_at ASC
      LIMIT $LIMIT OFFSET $OFFSET;
    "
    ;;

  search)
    KEYWORD="${1:?Usage: search <keyword> [limit]}"
    LIMIT="${2:-10}"
    sqlite3 -json "$DB_PATH" "
      SELECT phase_id, role, SUBSTR(content, 1, 500) AS content_preview, created_at
      FROM conversation_messages
      WHERE repo_task_id = '$TASK_ID'
        AND phase_id != '$CURRENT_PHASE'
        AND role IN ('user', 'assistant')
        AND content LIKE '%' || '$KEYWORD' || '%'
      ORDER BY created_at DESC
      LIMIT $LIMIT;
    "
    ;;

  help|*)
    cat <<'USAGE'
Usage: query-history.sh --db <path> --task <id> --phase <id> <command> [args]

Commands:
  list                          List all phases with conversation history
  get <phase-id> [limit] [off]  Get messages from a specific phase (paginated)
  search "<keyword>" [limit]    Full-text search across all phases
USAGE
    ;;
esac
