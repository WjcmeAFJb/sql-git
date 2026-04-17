#!/usr/bin/env bash
# Manual walkthrough of tracker + syncer — "day in the life of two devices"
# (desktop + phone) sharing a money tracker. Uses the public CLI:
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

# Seed desktop with schema + accounts + categories + some income.
# (Tracker auto-inits schema on master open, but we want realistic starting
# balances so the walkthrough exercises richer scenarios.)
node --experimental-strip-types - <<EOF
import { Store } from "./src/index.ts";
import { bankActions } from "./demo/actions.ts";
const s = Store.open({ root: "$ROOT/desktop", peerId: "desktop", masterId: "desktop", actions: bankActions });
s.submit("init_bank", {});
s.submit("create_account", { id: "checking", name: "Checking", ts: "1970-01-01T00:00:00.000Z" });
s.submit("create_account", { id: "savings", name: "Savings", ts: "1970-01-01T00:00:00.000Z" });
s.submit("create_category", { id: "food", name: "Food", kind: "expense", ts: "1970-01-01T00:00:00.000Z" });
s.submit("create_category", { id: "rent", name: "Rent", kind: "expense", ts: "1970-01-01T00:00:00.000Z" });
s.submit("create_category", { id: "salary", name: "Salary", kind: "income", ts: "1970-01-01T00:00:00.000Z" });
s.submit("create_income", { id: "salary-1", acc_to: "checking", amount: 100, category_id: "salary", memo: "paycheck", ts: "1970-01-01T00:00:00.000Z" });
s.submit("create_income", { id: "seed-sav", acc_to: "savings", amount: 200, category_id: null, memo: "initial savings", ts: "1970-01-01T00:00:00.000Z" });
await s.sync();
s.close();
EOF

"${SYNCER[@]}" sync "$ROOT/desktop" "$ROOT/phone"

S=walk-$$
tmux kill-session -t "$S" 2>/dev/null || true
tmux new-session -d -s "$S" -x 200 -y 42 -n desktop
tmux resize-window -t "$S" -x 200 -y 42
tmux send-keys -t "$S:desktop" "${TRACKER[*]} $ROOT/desktop --peer-id desktop --watch-debounce 150" Enter

tmux new-window -t "$S" -n phone
tmux send-keys -t "$S:phone" "${TRACKER[*]} $ROOT/phone --peer-id phone --watch-debounce 150" Enter

sleep 2

banner() { printf "\n=================================  %s  =================================\n" "$1"; }
show() {
  banner "$1"
  echo "---- desktop ----"; tmux capture-pane -t "$S:desktop" -p | sed -n '1,28p'
  echo "---- phone   ----"; tmux capture-pane -t "$S:phone"   -p | sed -n '1,28p'
}
sync() { "${SYNCER[@]}" sync "$ROOT/desktop" "$ROOT/phone" >/dev/null; }
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
press()   { tmux send-keys -t "$S:$1" "$2"; sleep 0.05; }
type_in() { tmux send-keys -t "$S:$1" -l "$2"; sleep 0.05; tmux send-keys -t "$S:$1" Enter; sleep 0.05; }
enter()   { tmux send-keys -t "$S:$1" Enter; sleep 0.05; }
pick()    { tmux send-keys -t "$S:$1" "$2"; sleep 0.05; }

# --- STEP 1: phone catches up ------------------------------------------------
wait_for phone "ACCT checking" 15
wait_for phone "\$100" 15
show "STEP 1 — phone caught up: salary + initial savings reflected"

# --- STEP 2: phone records a grocery expense ---------------------------------
# Phone: n → e (expense) → amount=15 → from=Checking (1) → category=Food (3) → memo=pasta → id=groceries-1
press   phone n; wait_for phone "New transaction" 5
press   phone e; wait_for phone "Amount" 5
type_in phone "15"
wait_for phone "From account" 5
pick    phone 1               # Checking
wait_for phone "Category" 5
pick    phone 2               # [1]none, [2]Food, [3]Rent, [4]Salary
wait_for phone "Memo" 5
type_in phone "pasta"
wait_for phone "Tx id" 5
type_in phone "groceries-1"
converge
wait_for desktop "TX groceries-1" 15
show "STEP 2 — phone: expense \$15 submitted and propagated"

# --- STEP 3: desktop pays rent ----------------------------------------------
press   desktop n; wait_for desktop "New transaction" 5
press   desktop e; wait_for desktop "Amount" 5
type_in desktop "40"
wait_for desktop "From account" 5
pick    desktop 1
wait_for desktop "Category" 5
pick    desktop 3              # Rent
wait_for desktop "Memo" 5
type_in desktop "november"
wait_for desktop "Tx id" 5
type_in desktop "rent-1"
converge
wait_for phone "TX rent-1" 15
show "STEP 3 — desktop: \$40 rent; phone sees it after sync"

# --- STEP 4: transfer from checking to savings (between accounts) -----------
press   phone n; wait_for phone "New transaction" 5
press   phone x; wait_for phone "Amount" 5
type_in phone "30"
wait_for phone "From" 5
pick    phone 1                # Checking
wait_for phone "To" 5
pick    phone 2                # Savings
wait_for phone "Memo" 5
type_in phone "monthly saving"
wait_for phone "Tx id" 5
type_in phone "save-1"
converge
wait_for desktop "TX save-1" 15
show "STEP 4 — phone transfers \$30 checking → savings"

# --- STEP 5: commuting edits: phone memo + desktop category -----------------
# Phone edits groceries-1's memo; desktop concurrently edits its category.
press   phone e; wait_for phone "Edit transaction — pick field" 5
press   phone m; wait_for phone "› Transaction:" 5
# Seeded ts order: salary-1, seed-sav, groceries-1, rent-1, save-1 → groceries-1=3.
pick    phone 3
wait_for phone "New memo" 5
type_in phone "pasta and wine"

press   desktop e; wait_for desktop "Edit transaction — pick field" 5
press   desktop c; wait_for desktop "› Transaction:" 5
pick    desktop 3            # groceries-1
wait_for desktop "Category" 5
pick    desktop 2            # food
converge
wait_for desktop "memo=\"pasta and wine\"" 15
wait_for desktop "cat=Food" 15
wait_for phone "cat=Food" 15
show "STEP 5 — different-field edits on same tx commute: both land"

# --- STEP 6: overdraft with retry+topup -------------------------------------
# Current balances: checking = 100 - 15 - 40 - 30 = 15; savings = 200 + 30 = 230.
# Desktop tries to spend $10, phone tries $12 — alone fine, together overdraft.
press   desktop n; wait_for desktop "New transaction" 5
press   desktop e; wait_for desktop "Amount" 5
type_in desktop "10"
wait_for desktop "From account" 5
pick    desktop 1
wait_for desktop "Category" 5
pick    desktop 1
wait_for desktop "Memo" 5
enter   desktop
wait_for desktop "Tx id" 5
type_in desktop "gas-1"

press   phone n; wait_for phone "New transaction" 5
press   phone e; wait_for phone "Amount" 5
type_in phone "12"
wait_for phone "From account" 5
pick    phone 1
wait_for phone "Category" 5
pick    phone 1
wait_for phone "Memo" 5
enter   phone
wait_for phone "Tx id" 5
type_in phone "taxi-1"

converge
wait_for desktop "TX gas-1" 15
wait_for phone "CONFLICT" 20

press   phone r; wait_for phone "RETRY" 5
type_in phone "20 savings checking topup"
wait_for phone "TX taxi-1" 20
converge
wait_for desktop "TX taxi-1" 15
show "STEP 6 — overdraft! phone retried with a savings→checking topup"

# --- STEP 7: delete a transaction --------------------------------------------
press   phone d; wait_for phone "Delete transaction" 5
# Order-by-ts (seed ts=1970… comes first): salary-1, seed-sav, groceries-1,
# rent-1, save-1, gas-1, taxi-1 (original submit), topup-… (retry). taxi-1 = 7.
pick    phone 7
converge
wait_for phone "pending (0)" 15
if tmux capture-pane -t "$S:desktop" -p | grep -q "TX taxi-1"; then
  echo "taxi-1 should have been deleted!"; exit 1
fi
show "STEP 7 — phone deleted taxi-1; desktop no longer shows it"

# --- STEP 8: category CRUD round-trip on phone -------------------------------
press   phone c; wait_for phone "\\[c\\] Categories" 5
press   phone n; wait_for phone "Name" 5
type_in phone "Entertainment"
wait_for phone "Kind" 5
pick    phone 2            # expense
wait_for phone "Short id" 5
type_in phone "fun"
wait_for phone "CAT fun" 10

press   phone r; wait_for phone "Rename category" 5
# Pick fun. Categories listed in insertion order: food, rent, salary, fun → fun=4.
pick    phone 4
wait_for phone "New name" 5
type_in phone "Leisure"
wait_for phone "Leisure" 10

press   phone d; wait_for phone "Delete category" 5
pick    phone 4
converge
press   desktop c
wait_for desktop "\\[c\\] Categories" 5
# "fun" (Leisure) was created, renamed, and deleted on phone — desktop should
# have also incorporated + removed it, so its category list matches phone's.
if tmux capture-pane -t "$S:desktop" -p | grep -q "Leisure"; then
  echo "Leisure should have been deleted!"; exit 1
fi
show "STEP 8 — category create/rename/delete round-tripped to desktop"

echo
echo "Session: tmux attach -t $S    (Ctrl-B D to detach; Ctrl-B n to switch windows)"
echo "To tear down: tmux kill-session -t $S  &&  rm -rf $ROOT"
