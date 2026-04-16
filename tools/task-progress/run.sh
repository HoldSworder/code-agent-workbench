#!/usr/bin/env bash
# Query workflow task progress from the code-agent database.
# Part of the code-agent WorkflowTool system.
set -euo pipefail

DB_PATH=""
TASK_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)   DB_PATH="$2"; shift 2 ;;
    --task) TASK_ID="$2"; shift 2 ;;
    *)      break ;;
  esac
done

if [[ -z "$DB_PATH" || -z "$TASK_ID" ]]; then
  echo '{"error":"Missing required args: --db <path> --task <id>"}' >&2
  exit 1
fi

if ! command -v sqlite3 &>/dev/null; then
  echo '{"error":"sqlite3 CLI not found. Please install sqlite3."}' >&2
  exit 1
fi

cmd="${1:-help}"
shift 2>/dev/null || true

case "$cmd" in
  overview)
    sqlite3 -json "$DB_PATH" "
      SELECT
        id,
        current_stage,
        current_phase,
        phase_status,
        branch_name,
        change_id,
        openspec_path,
        worktree_path,
        workflow_id,
        workflow_completed,
        created_at,
        updated_at
      FROM repo_tasks
      WHERE id = '$TASK_ID';
    "
    ;;

  phases)
    sqlite3 -json "$DB_PATH" "
      SELECT
        ap.phase_id,
        ap.created_at AS activated_at,
        COALESCE(mc.msg_count, 0) AS message_count,
        pc.commit_sha,
        ar.provider AS last_provider,
        ar.status AS last_run_status,
        ar.finished_at AS last_run_finished,
        CASE
          WHEN t.current_phase = ap.phase_id THEN t.phase_status
          WHEN pc.commit_sha IS NOT NULL THEN 'completed'
          WHEN mc.msg_count > 0 THEN 'has_conversation'
          ELSE 'activated'
        END AS inferred_status
      FROM activated_phases ap
      LEFT JOIN (
        SELECT phase_id, COUNT(*) AS msg_count
        FROM conversation_messages
        WHERE repo_task_id = '$TASK_ID' AND role IN ('user', 'assistant')
        GROUP BY phase_id
      ) mc ON mc.phase_id = ap.phase_id
      LEFT JOIN phase_commits pc
        ON pc.repo_task_id = '$TASK_ID' AND pc.phase_id = ap.phase_id
      LEFT JOIN (
        SELECT phase_id, provider, status, finished_at
        FROM agent_runs
        WHERE repo_task_id = '$TASK_ID'
          AND id IN (
            SELECT id FROM agent_runs
            WHERE repo_task_id = '$TASK_ID'
            GROUP BY phase_id
            HAVING started_at = MAX(started_at)
          )
      ) ar ON ar.phase_id = ap.phase_id
      LEFT JOIN repo_tasks t ON t.id = '$TASK_ID'
      WHERE ap.repo_task_id = '$TASK_ID'
      ORDER BY ap.created_at ASC;
    "
    ;;

  commits)
    sqlite3 -json "$DB_PATH" "
      SELECT phase_id, commit_sha, created_at
      FROM phase_commits
      WHERE repo_task_id = '$TASK_ID'
      ORDER BY created_at ASC;
    "
    ;;

  help|*)
    cat <<'USAGE'
Usage: task-progress.sh --db <path> --task <id> <command>

Commands:
  overview    Task info: current stage/phase/status, branch, paths
  phases      All activated phases with message count, commit, last run status
  commits     Commits associated with each phase
USAGE
    ;;
esac
