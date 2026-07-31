#!/usr/bin/env bash
# Local 3-master Redis Cluster for integration tests (no docker needed).
# Usage: scripts/cluster-test-env.sh up|down
set -euo pipefail
PORTS=(7100 7101 7102)
DIR="${TMPDIR:-/tmp}/nch-cluster"

up() {
  mkdir -p "$DIR"
  for p in "${PORTS[@]}"; do
    redis-server --port "$p" --cluster-enabled yes \
      --cluster-config-file "$DIR/nodes-$p.conf" \
      --daemonize yes --save "" --appendonly no \
      --logfile "$DIR/redis-$p.log" --dir "$DIR"
  done
  sleep 0.5
  redis-cli --cluster create $(for p in "${PORTS[@]}"; do echo -n "127.0.0.1:$p "; done) \
    --cluster-replicas 0 --cluster-yes > "$DIR/create.log" 2>&1
  # Wait for cluster_state:ok on every node.
  for i in $(seq 1 20); do
    ok=1
    for p in "${PORTS[@]}"; do
      state=$(redis-cli -p "$p" cluster info 2>/dev/null | grep cluster_state | tr -d '\r')
      [[ "$state" == "cluster_state:ok" ]] || ok=0
    done
    [[ $ok == 1 ]] && break
    sleep 0.5
  done
  redis-cli -p "${PORTS[0]}" cluster info | grep cluster_state
}

down() {
  for p in "${PORTS[@]}"; do
    redis-cli -p "$p" shutdown nosave 2>/dev/null || true
  done
  rm -rf "$DIR"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up|down" >&2; exit 1 ;;
esac
