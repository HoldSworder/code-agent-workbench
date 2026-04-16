#!/usr/bin/env bash
# Query configured repositories from the code-agent database.
# Part of the code-agent WorkflowTool system.
set -euo pipefail

DB_PATH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) DB_PATH="$2"; shift 2 ;;
    *)    break ;;
  esac
done

if [[ -z "$DB_PATH" ]]; then
  echo '{"error":"Missing required arg: --db <path>"}' >&2
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
      SELECT id, name, alias, local_path, default_branch, agent_provider, created_at
      FROM repos
      ORDER BY created_at DESC, rowid DESC;
    "
    ;;

  get)
    QUERY="${1:-}"
    if [[ -z "$QUERY" ]]; then
      echo '{"error":"Usage: get <id_or_name_or_alias>"}' >&2
      exit 1
    fi
    sqlite3 -json "$DB_PATH" "
      SELECT id, name, alias, local_path, default_branch, agent_provider, created_at
      FROM repos
      WHERE id = '$QUERY' OR name = '$QUERY' OR alias = '$QUERY'
      LIMIT 1;
    "
    ;;

  tasks)
    REPO_ID="${1:-}"
    if [[ -z "$REPO_ID" ]]; then
      echo '{"error":"Usage: tasks <repo_id_or_name_or_alias>"}' >&2
      exit 1
    fi
    sqlite3 -json "$DB_PATH" "
      SELECT
        rt.id,
        rt.branch_name,
        rt.change_id,
        rt.current_stage,
        rt.current_phase,
        rt.phase_status,
        rt.workflow_completed,
        rt.created_at,
        rt.updated_at,
        r.title AS requirement_title
      FROM repo_tasks rt
      LEFT JOIN requirements r ON r.id = rt.requirement_id
      WHERE rt.repo_id IN (
        SELECT id FROM repos
        WHERE id = '$REPO_ID' OR name = '$REPO_ID' OR alias = '$REPO_ID'
      )
      ORDER BY rt.updated_at DESC;
    "
    ;;

  help|*)
    cat <<'USAGE'
Usage: repo-info.sh --db <path> <command> [args]

Commands:
  list                        List all configured repositories
  get <id|name|alias>         Get a single repo by id, name, or alias
  tasks <id|name|alias>       List all tasks for a repo
USAGE
    ;;
esac
