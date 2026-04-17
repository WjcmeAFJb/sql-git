#!/usr/bin/env bash
# Manual walkthrough of tracker + syncer — "day in the life of two devices"
# (desktop + phone) sharing a money tracker. Uses only the new CLI:
#   syncer create-host PATH [--master ID]
#   syncer sync A B [...]
#   tracker PATH --peer-id ID
set -euo pipefail

ROOT=${ROOT:-/tmp/sqlgit-walk}
rm -rf "$ROOT"
mkdir -p "$ROOT"
cd "$(dirname "$0")/.."

SYNCER=(./node_modules/.bin/tsx ./demo/syncer.ts)
TRACKER=(./node_modules/.bin/tsx ./demo/tracker.tsx)

"${SYNCER[@]}" create-host "$ROOT/desktop" --master desktop
"${SYNCER[@]}" create-host "$ROOT/phone"   --master desktop

# Seed desktop (the master) with a realistic starting state before any TUI opens.
node --experimental-strip-types - <<EOF
import { Store } from "./src/index.ts";
import { bankActions } from "./demo/actions.ts";
const s = Store.open({ root: "$ROOT/desktop", peerId: "desktop", masterId: "desktop", actions: bankActions });
s.submit("init_bank", {});
s.submit("create_account", { id: "checking", name: "Checking", ts: "t0" });
s.submit("create_account", { id: "savings", name: "Savings", ts: "t0" });
s.submit("create_category", { id: "food", name: "Food", kind: "expense", ts: "t0" });
s.submit("create_category", { id: "rent", name: "Rent", kind: "expense", ts: "t0" });
s.submit("create_category", { id: "salary", name: "Salary", kind: "income", ts: "t0" });
s.submit("create_income", { id: "salary-1", acc_to: "checking", amount: 100, category_id: "salary", memo: "paycheck", ts: "t0" });
s.submit("create_income", { id: "seed-sav", acc_to: "savings", amount: 200, category_id: null, memo: "initial savings", ts: "t0" });
await s.sync();
s.close();
EOF

"${SYNCER[@]}" sync "$ROOT/desktop" "$ROOT/phone"

S=walk-$$
tmux kill-session -t "$S" 2>/dev/null || true
tmux new-session -d -s "$S" -x 200 -y 42 -n desktop
tmux resize-window -t "$S" -x 200 -y 42  # actually size the detached pty
tmux send-keys -t "$S:desktop" "${TRACKER[*]} $ROOT/desktop --peer-id desktop --watch-debounce 150" Enter

tmux new-window -t "$S" -n phone
tmux send-keys -t "$S:phone" "${TRACKER[*]} $ROOT/phone --peer-id phone --watch-debounce 150" Enter

sleep 2

banner() { printf "\n=================================  %s  =================================\n" "$1"; }
show() {
  banner "$1"
  echo "---- desktop ----"; tmux capture-pane -t "$S:desktop" -p | sed -n '1,25p'
  echo "---- phone   ----"; tmux capture-pane -t "$S:phone"   -p | sed -n '1,25p'
}
sync() { "${SYNCER[@]}" sync "$ROOT/desktop" "$ROOT/phone" >/dev/null; }
# Two-phase sync + short wait: propagates peer→master, gives master's watcher
# time to process, then propagates master→peer so both sides fully converge.
converge() { sync; sleep 0.4; sync; }
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
press()   { tmux send-keys -t "$S:$1" "$2"; }

# --- STEP 1: phone catches up ------------------------------------------------
wait_for phone "ACCT checking" 15
wait_for phone "\$100" 15
show "STEP 1 — phone caught up: balances reflect salary and initial savings"

# --- STEP 2: phone records a grocery expense ---------------------------------
press  phone n; wait_for phone "New transaction" 5
press  phone e; wait_for phone "New expense" 5
type_in phone "groceries-1 checking 15 food pasta"
sync
wait_for desktop "TX groceries-1" 15
sync
wait_for phone "TX groceries-1" 15
show "STEP 2 — phone: expense \$15 for pasta (category=food) propagated both ways"

# --- STEP 3: desktop pays rent ----------------------------------------------
press  desktop n; wait_for desktop "New transaction" 5
press  desktop e; wait_for desktop "New expense" 5
type_in desktop "rent-1 checking 40 rent november"
sync
wait_for phone "TX rent-1" 15
show "STEP 3 — desktop: \$40 rent; phone sees it after sync"

# --- STEP 4: transfer from checking to savings (between accounts) -----------
press  phone n; wait_for phone "New transaction" 5
press  phone x; wait_for phone "New transfer" 5
type_in phone "save-1 checking savings 30 monthly saving"
sync
wait_for desktop "TX save-1" 15
show "STEP 4 — phone transfers \$30 checking → savings"

# --- STEP 5: commuting edits: phone memo + desktop category ------------------
press  phone e; wait_for phone "Edit transaction" 5
press  phone m; wait_for phone "Edit transaction memo" 5
type_in phone "groceries-1 pasta and wine"
press  desktop e; wait_for desktop "Edit transaction" 5
press  desktop c; wait_for desktop "Edit transaction category" 5
type_in desktop "groceries-1 food"
sync
wait_for desktop 'memo="pasta and wine"' 15
wait_for desktop 'cat=Food' 15
sync
wait_for phone 'memo="pasta and wine"' 15
show "STEP 5 — commuting edits: memo + category on same tx both land"

# --- STEP 6: overdraft with retry+topup -------------------------------------
# After steps above: checking = 100 - 15 - 40 - 30 = 15 ; savings = 200 + 30 = 230
press  desktop n; wait_for desktop "New transaction" 5
press  desktop e; wait_for desktop "New expense" 5
type_in desktop "gas-1 checking 10"
press  phone   n; wait_for phone   "New transaction" 5
press  phone   e; wait_for phone   "New expense" 5
type_in phone   "taxi-1 checking 12"
sync
wait_for desktop "TX gas-1" 15
sync
wait_for phone "CONFLICT" 20
press   phone r; wait_for phone "RETRY" 5
type_in phone "phone-topup savings checking 20"
wait_for phone "TX phone-topup" 20
converge
wait_for desktop "TX phone-topup" 15
wait_for desktop "TX taxi-1" 15
wait_for phone "pending (0)" 15
show "STEP 6 — overdraft! phone retried with a savings→checking topup"

# --- STEP 7: delete a transaction --------------------------------------------
press  phone d; wait_for phone "Delete transaction" 5
type_in phone "taxi-1"
converge                            # two-phase: phone→desktop, then desktop→phone
wait_for phone "pending (0)" 15
if tmux capture-pane -t "$S:desktop" -p | grep -q "TX taxi-1"; then
  echo "TX taxi-1 should have been deleted!"; exit 1
fi
show "STEP 7 — phone deleted taxi-1; balances restored; master propagates the delete"

# --- STEP 8: create + rename + delete a category (CRUD) ----------------------
press   phone c; wait_for phone "\\[c\\] Categories" 5
press   phone n; wait_for phone "New category" 5
type_in phone "entertainment Entertainment expense"
wait_for phone "CAT entertainment" 10
press   phone r; wait_for phone "Rename category" 5
type_in phone "entertainment Fun"
wait_for phone "Fun" 10
press   phone d; wait_for phone "Delete category" 5
type_in phone "entertainment"
converge
wait_for phone "pending (0)" 15
press   desktop c
wait_for desktop "\\[c\\] Categories" 5
show "STEP 8 — category CRUD round-trip on phone propagated to desktop"

echo
echo "Session: tmux attach -t $S    (Ctrl-B D to detach; Ctrl-B n to switch windows)"
echo "To tear down: tmux kill-session -t $S  &&  rm -rf $ROOT"
