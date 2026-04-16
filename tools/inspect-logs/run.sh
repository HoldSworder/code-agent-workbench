#!/usr/bin/env bash
# Inspect code-agent runtime logs (engine, provider, etc.).
# Part of the code-agent WorkflowTool system.
set -euo pipefail

LOG_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tmpdir) LOG_DIR="$2"; shift 2 ;;
    *)        break ;;
  esac
done

if [[ -z "$LOG_DIR" ]]; then
  echo '{"error":"Missing required arg: --tmpdir <path>"}' >&2
  exit 1
fi

cmd="${1:-help}"
shift 2>/dev/null || true

case "$cmd" in
  list)
    if [[ ! -d "$LOG_DIR" ]]; then
      echo '[]'
      exit 0
    fi
    result="["
    first=true
    for f in "$LOG_DIR"/code-agent-*.log; do
      [[ -e "$f" ]] || continue
      name=$(basename "$f")
      size=$(wc -c < "$f" | tr -d ' ')
      lines=$(wc -l < "$f" | tr -d ' ')
      mtime=$(stat -f '%Sm' -t '%Y-%m-%dT%H:%M:%S' "$f" 2>/dev/null \
           || stat -c '%y' "$f" 2>/dev/null | cut -d. -f1 \
           || echo "unknown")
      if $first; then first=false; else result+=","; fi
      result+="{\"name\":\"$name\",\"size_bytes\":$size,\"lines\":$lines,\"modified\":\"$mtime\"}"
    done
    result+="]"
    echo "$result"
    ;;

  tail)
    LOG_NAME="${1:?Usage: tail <log-name> [lines]}"
    LINES="${2:-50}"
    target="$LOG_DIR/$LOG_NAME"
    if [[ ! -f "$target" ]]; then
      echo "{\"error\":\"Log file not found: $LOG_NAME\"}" >&2
      exit 1
    fi
    tail -n "$LINES" "$target"
    ;;

  search)
    LOG_NAME="${1:?Usage: search <log-name> \"keyword\" [limit]}"
    KEYWORD="${2:?Usage: search <log-name> \"keyword\" [limit]}"
    LIMIT="${3:-20}"
    target="$LOG_DIR/$LOG_NAME"
    if [[ ! -f "$target" ]]; then
      echo "{\"error\":\"Log file not found: $LOG_NAME\"}" >&2
      exit 1
    fi
    grep -n "$KEYWORD" "$target" | tail -n "$LIMIT"
    ;;

  help|*)
    cat <<'USAGE'
Usage: inspect-logs.sh --tmpdir <path> <command> [args]

Commands:
  list                                   List all code-agent log files
  tail <log-name> [lines=50]             Show last N lines of a log
  search <log-name> "keyword" [limit=20] Search a log file by keyword
USAGE
    ;;
esac
