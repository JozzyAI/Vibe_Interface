#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${VI_ROOT:-/mnt/e/project/PI}"
WEB_DIR="$ROOT_DIR/packages/web"
NODE_BIN="${VI_NODE_BIN:-/home/lijoe/.nvm/versions/node/v20.19.5/bin}"
SESSION_NEXT="${VI_NEXT_TMUX:-vi-next}"
SESSION_WS="${VI_WS_TMUX:-vi-direct-terminal}"
WEB_PORT="${VI_WEB_PORT:-3000}"
PATH="$NODE_BIN:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

if [[ ! -d "$WEB_DIR" ]]; then
  echo "PI web directory not found: $WEB_DIR" >&2
  exit 1
fi

if [[ ! -x "$NODE_BIN/node" ]]; then
  echo "Node not found at $NODE_BIN/node" >&2
  echo "Set VI_NODE_BIN to the directory containing node >= 20." >&2
  exit 1
fi

tmux kill-session -t "$SESSION_NEXT" 2>/dev/null || true
tmux kill-session -t "$SESSION_WS" 2>/dev/null || true

tmux new-session -d -s "$SESSION_NEXT" -c "$WEB_DIR"
tmux send-keys -l -t "$SESSION_NEXT" "PATH=$PATH ./node_modules/.bin/next dev -p $WEB_PORT -H 0.0.0.0"
tmux send-keys -t "$SESSION_NEXT" C-m

tmux new-session -d -s "$SESSION_WS" -c "$WEB_DIR"
tmux send-keys -l -t "$SESSION_WS" "PATH=$PATH ./node_modules/.bin/tsx watch server/direct-terminal-ws.ts"
tmux send-keys -t "$SESSION_WS" C-m

ip_addr="$(ip addr show eth0 | awk '/inet / {print $2}' | cut -d/ -f1 | head -n 1)"

echo "VI dashboard starting:"
echo "  Next.js tmux:        $SESSION_NEXT"
echo "  DirectTerminal tmux: $SESSION_WS"
echo "  URL:                 http://${ip_addr:-127.0.0.1}:$WEB_PORT"
echo
echo "Logs:"
echo "  tmux capture-pane -t $SESSION_NEXT -p -S -120"
echo "  tmux capture-pane -t $SESSION_WS -p -S -120"
