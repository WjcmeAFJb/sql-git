#!/usr/bin/env bash
# Manual walkthrough of the TUI + syncer: simulates a "day in the life" of
# two devices (master / alice) sharing a money tracker via Syncthing.
# Each STEP prints the three panes so you can see the cluster converge.
set -euo pipefail

ROOT=${ROOT:-/tmp/sqlgit-walk}
rm -rf "$ROOT"
mkdir -p "$ROOT/master" "$ROOT/alice"
cd "$(dirname "$0")/.."

# Seed master before any TUI opens.
node --experimental-strip-types - <<EOF
import { Store } from "./src/index.ts";
import { bankActions } from "./demo/actions.ts";
const s = Store.open({ root: "$ROOT/master", peerId: "master", masterId: "master", actions: bankActions });
s.submit("init_bank", {});
s.submit("open_account", { id: "checking", initial: 100 });
s.submit("open_account", { id: "savings", initial: 200 });
s.submit("open_account", { id: "external", initial: 0 });
await s.sync();
s.close();
EOF

S=walk-$$
tmux kill-session -t "$S" 2>/dev/null || true
tmux new-session -d -s "$S" -x 180 -y 36
tmux rename-window -t "$S:0" master
tmux send-keys -t "$S:0" "./node_modules/.bin/tsx demo/cli.tsx --root $ROOT/master --peer master --master master --watch-debounce 150" Enter

tmux new-window  -t "$S" -n alice
tmux send-keys -t "$S:alice" "./node_modules/.bin/tsx demo/cli.tsx --root $ROOT/alice  --peer alice  --master master --watch-debounce 150" Enter

tmux new-window  -t "$S" -n syncer
tmux send-keys -t "$S:syncer" "./node_modules/.bin/tsx demo/sync.ts watch --host master=$ROOT/master --host alice=$ROOT/alice --master master --debounce 100 -v" Enter

sleep 2

banner() { printf "\n=================================  %s  =================================\n" "$1"; }
show() {
  banner "$1"
  echo "---- master ----"; tmux capture-pane -t "$S:master" -p | sed -n '1,20p'
  echo "---- alice  ----"; tmux capture-pane -t "$S:alice"  -p | sed -n '1,20p'
  echo "---- syncer ----"; tmux capture-pane -t "$S:syncer" -p | sed -n '1,10p'
}
wait_for() {
  # wait_for window needle max-seconds
  local w=$1 needle=$2 max=${3:-15}
  local start=$SECONDS
  while :; do
    if tmux capture-pane -t "$S:$w" -p | grep -q -- "$needle"; then return 0; fi
    (( SECONDS - start > max )) && { echo "TIMEOUT waiting on $w for '$needle'"; tmux capture-pane -t "$S:$w" -p; exit 1; }
    sleep 0.2
  done
}
type_in() {  # window, text
  tmux send-keys -t "$S:$1" -l "$2"
  tmux send-keys -t "$S:$1" Enter
}

# --- STEP 1: alice catches up ------------------------------------------------
wait_for alice "ACCT checking 100" 15
show "STEP 1 — alice catches up via syncer on startup"

# --- STEP 2: alice makes a non-conflicting transfer --------------------------
tmux send-keys -t "$S:alice" t
wait_for alice "TRANSFER-FORM" 5
type_in alice "coffee-1 checking external 5"
wait_for master "TX coffee-1"    15
wait_for alice  "TX coffee-1"    15
show "STEP 2 — alice's 5-unit transfer propagated & incorporated"

# --- STEP 3: master's own transfer converges on alice ------------------------
tmux send-keys -t "$S:master" t
wait_for master "TRANSFER-FORM" 5
type_in master "rent-1 checking external 20"
wait_for master "TX rent-1" 15
wait_for alice  "TX rent-1" 15
show "STEP 3 — master submitted its own transfer; alice catches up"

# --- STEP 4: commuting edits (alice memo + master category on same tx) ------
tmux send-keys -t "$S:alice" m
wait_for alice "MEMO-FORM" 5
type_in alice 'coffee-1 morning-latte'
tmux send-keys -t "$S:master" c
wait_for master "CATEGORY-FORM" 5
type_in master "coffee-1 food"
wait_for master 'memo="morning-latte".*cat=food\|cat=food.*memo="morning-latte"' 20
wait_for alice  'memo="morning-latte".*cat=food\|cat=food.*memo="morning-latte"' 20
show "STEP 4 — different-field edits on same tx commute and both land"

# --- STEP 5: same-field conflict, alice drops -------------------------------
tmux send-keys -t "$S:alice" m
wait_for alice "MEMO-FORM" 5
type_in alice 'rent-1 alice-note'
tmux send-keys -t "$S:master" m
wait_for master "MEMO-FORM" 5
type_in master 'rent-1 master-note'
# Master will apply its own update locally; alice's sync will hit conflict vs master's note.
wait_for master 'memo="master-note"' 15
wait_for alice  'CONFLICT kind=non_commutative' 15
tmux send-keys -t "$S:alice" d
wait_for alice  'memo="master-note"' 15
show "STEP 5 — alice tried a conflicting memo edit; dropped → master's wins"

# --- STEP 6: overdraft with retry+topup -------------------------------------
# Current balances (one way to read: from master screen): after steps so far.
# Let the user overdraw. Alice opens a transfer that drains checking past 0;
# master concurrently takes a chunk; alice resolves with a retry topup.
tmux send-keys -t "$S:master" t
wait_for master "TRANSFER-FORM" 5
type_in master "gas-1 checking external 60"
tmux send-keys -t "$S:alice" t
wait_for alice "TRANSFER-FORM" 5
type_in alice  "uber-1 checking external 50"
wait_for master "TX gas-1" 15
wait_for alice  "CONFLICT kind=error" 20
tmux send-keys -t "$S:alice" r
wait_for alice "RETRY-FORM" 5
type_in alice  "alice-topup savings checking 60"
wait_for alice "TX alice-topup" 20
wait_for master "TX alice-topup" 20
wait_for master "TX uber-1" 20
show "STEP 6 — alice's transfer would overdraft; retried with topup from savings"

# --- STEP 7: force a same-field memo conflict -------------------------------
tmux send-keys -t "$S:alice" m
wait_for alice "MEMO-FORM" 5
type_in alice "rent-1 alice-insists"
tmux send-keys -t "$S:master" m
wait_for master "MEMO-FORM" 5
type_in master "rent-1 master-insists"
wait_for alice 'CONFLICT kind=non_commutative' 15
tmux send-keys -t "$S:alice" f     # alice forces
wait_for alice  'memo="alice-insists"' 15
wait_for master 'memo="alice-insists"' 15
show "STEP 7 — alice forces her memo; master's stale conflicting edit is superseded"

echo
echo "Walkthrough session: tmux attach -t $S"
echo "(Leave running so you can inspect the panes; Ctrl-B D detaches.)"
