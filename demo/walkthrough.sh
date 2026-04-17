#!/usr/bin/env bash
# Manual walkthrough of tracker + syncer: simulates a "day in the life" of
# two devices (desktop / phone) sharing a money tracker. Each STEP prints
# the three panes so you can see the cluster converge.
#
# Uses only two CLI commands:
#   syncer create-host <path> [--master <id>]
#   syncer sync <path> <path> …
#   tracker <path> --peer-id <id>
set -euo pipefail

ROOT=${ROOT:-/tmp/sqlgit-walk}
rm -rf "$ROOT"
mkdir -p "$ROOT"
cd "$(dirname "$0")/.."

SYNCER=(./node_modules/.bin/tsx ./demo/syncer.ts)
TRACKER=(./node_modules/.bin/tsx ./demo/tracker.tsx)

"${SYNCER[@]}" create-host "$ROOT/desktop" --master desktop
"${SYNCER[@]}" create-host "$ROOT/phone"   --master desktop

# Seed desktop (which IS the master) before any TUI opens.
node --experimental-strip-types - <<EOF
import { Store } from "./src/index.ts";
import { bankActions } from "./demo/actions.ts";
const s = Store.open({ root: "$ROOT/desktop", peerId: "desktop", masterId: "desktop", actions: bankActions });
s.submit("init_bank", {});
s.submit("open_account", { id: "checking", initial: 100 });
s.submit("open_account", { id: "savings", initial: 200 });
s.submit("open_account", { id: "external", initial: 0 });
await s.sync();
s.close();
EOF

# Push the seeded state to phone so her initial open sees it.
"${SYNCER[@]}" sync "$ROOT/desktop" "$ROOT/phone"

S=walk-$$
tmux kill-session -t "$S" 2>/dev/null || true
tmux new-session -d -s "$S" -x 180 -y 36 -n desktop
tmux send-keys -t "$S:desktop" "${TRACKER[*]} $ROOT/desktop --peer-id desktop --watch-debounce 150" Enter

tmux new-window -t "$S" -n phone
tmux send-keys -t "$S:phone" "${TRACKER[*]} $ROOT/phone --peer-id phone --watch-debounce 150" Enter

sleep 2

banner() { printf "\n=================================  %s  =================================\n" "$1"; }
show() {
  banner "$1"
  echo "---- desktop ----"; tmux capture-pane -t "$S:desktop" -p | sed -n '1,20p'
  echo "---- phone   ----"; tmux capture-pane -t "$S:phone"   -p | sed -n '1,20p'
}
sync() { "${SYNCER[@]}" sync "$ROOT/desktop" "$ROOT/phone" >/dev/null; }
wait_for() {
  local w=$1 needle=$2 max=${3:-15}
  local start=$SECONDS
  while :; do
    if tmux capture-pane -t "$S:$w" -p | grep -q -- "$needle"; then return 0; fi
    (( SECONDS - start > max )) && { echo "TIMEOUT waiting on $w for '$needle'"; tmux capture-pane -t "$S:$w" -p; exit 1; }
    sleep 0.2
  done
}
type_in() { tmux send-keys -t "$S:$1" -l "$2"; tmux send-keys -t "$S:$1" Enter; }

# --- STEP 1: phone catches up via syncer sync ---------------------------------
wait_for phone "ACCT checking 100" 15
show "STEP 1 — phone caught up from desktop via 'syncer sync' (ran once before TUIs launched)"

# --- STEP 2: phone makes a non-conflicting transfer --------------------------
tmux send-keys -t "$S:phone" t
wait_for phone "TRANSFER-FORM" 5
type_in phone "coffee-1 checking external 5"
sync
wait_for desktop "TX coffee-1" 15
sync
wait_for phone "TX coffee-1" 15
show "STEP 2 — phone's 5-unit transfer synced and incorporated by desktop"

# --- STEP 3: desktop's own transfer converges on phone -----------------------
tmux send-keys -t "$S:desktop" t
wait_for desktop "TRANSFER-FORM" 5
type_in desktop "rent-1 checking external 20"
sync
wait_for phone "TX rent-1" 15
show "STEP 3 — desktop's own transfer reached phone after one sync"

# --- STEP 4: commuting edits (phone memo + desktop category on same tx) ------
tmux send-keys -t "$S:phone" m
wait_for phone "MEMO-FORM" 5
type_in phone 'coffee-1 morning-latte'
tmux send-keys -t "$S:desktop" c
wait_for desktop "CATEGORY-FORM" 5
type_in desktop "coffee-1 food"
sync
wait_for desktop 'memo="morning-latte"' 15
wait_for desktop 'cat=food' 15
sync
wait_for phone 'memo="morning-latte".*cat=food\|cat=food.*memo="morning-latte"' 15
show "STEP 4 — different-field edits on same tx commute and both land"

# --- STEP 5: same-field conflict, phone drops --------------------------------
tmux send-keys -t "$S:phone" m
wait_for phone "MEMO-FORM" 5
type_in phone 'rent-1 phone-note'
tmux send-keys -t "$S:desktop" m
wait_for desktop "MEMO-FORM" 5
type_in desktop 'rent-1 desktop-note'
sync
wait_for desktop 'memo="desktop-note"' 15
sync
wait_for phone 'CONFLICT kind=non_commutative' 15
tmux send-keys -t "$S:phone" d
wait_for phone 'memo="desktop-note"' 15
show "STEP 5 — phone's conflicting memo dropped; desktop's wins"

# --- STEP 6: overdraft with retry+topup --------------------------------------
tmux send-keys -t "$S:desktop" t
wait_for desktop "TRANSFER-FORM" 5
type_in desktop "gas-1 checking external 60"
tmux send-keys -t "$S:phone" t
wait_for phone "TRANSFER-FORM" 5
type_in phone  "uber-1 checking external 50"
sync
wait_for desktop "TX gas-1" 15
sync
wait_for phone "CONFLICT kind=error" 20
tmux send-keys -t "$S:phone" r
wait_for phone "RETRY-FORM" 5
type_in phone  "phone-topup savings checking 60"
wait_for phone "TX phone-topup" 20
sync
wait_for desktop "TX phone-topup" 20
wait_for desktop "TX uber-1" 20
show "STEP 6 — phone's transfer would overdraft; retried with topup from savings"

# --- STEP 7: force a same-field memo conflict --------------------------------
tmux send-keys -t "$S:phone" m
wait_for phone "MEMO-FORM" 5
type_in phone "rent-1 phone-insists"
tmux send-keys -t "$S:desktop" m
wait_for desktop "MEMO-FORM" 5
type_in desktop "rent-1 desktop-insists"
sync
wait_for phone 'CONFLICT kind=non_commutative' 15
tmux send-keys -t "$S:phone" f
wait_for phone  'memo="phone-insists"' 15
sync
wait_for desktop 'memo="phone-insists"' 15
show "STEP 7 — phone forces her memo; desktop's stale edit is superseded"

echo
echo "Session: tmux attach -t $S    (Ctrl-B D to detach)"
echo "To tear down: tmux kill-session -t $S  &&  rm -rf $ROOT"
