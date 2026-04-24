import { useEffect, useState } from "react";
import { Users, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";

const MASTER_ID = "alice";
const DEFAULT_SUGGESTIONS = ["alice", "bob", "charlie"];

export function PeerGate({
  onSelect,
  knownPeers,
}: {
  onSelect: (peerId: string) => void;
  knownPeers: string[];
}) {
  const [custom, setCustom] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Merge suggested + known peers; known first.
  const suggestions = Array.from(
    new Set([...knownPeers, ...DEFAULT_SUGGESTIONS]),
  );

  useEffect(() => {
    document.title = "sql-git · pick a peer";
    return () => {
      document.title = "sql-git · OPFS bank demo";
    };
  }, []);

  const submit = (id: string) => {
    const name = id.trim().toLowerCase();
    if (!name) {
      setError("peer id can't be empty");
      return;
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
      setError("use lowercase letters/digits, dots, dashes, underscores");
      return;
    }
    onSelect(name);
  };

  return (
    <Dialog open>
      <DialogContent hideClose className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" /> Choose a peer for this tab
          </DialogTitle>
          <DialogDescription>
            Each tab acts as one peer. The peer's storage lives in a
            dedicated OPFS folder — open another tab to act as a different
            peer and watch cross-tab sync.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="text-xs uppercase text-muted-foreground">
              Existing / suggested
            </Label>
            <div className="mt-2 flex flex-wrap gap-2">
              {suggestions.map((id) => {
                const isMaster = id === MASTER_ID;
                const isExisting = knownPeers.includes(id);
                return (
                  <button
                    key={id}
                    onClick={() => submit(id)}
                    className="group flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-accent"
                  >
                    <span className="font-mono">{id}</span>
                    {isMaster ? (
                      <Badge variant="warning" className="h-4 px-1 text-[10px]">
                        master
                      </Badge>
                    ) : null}
                    {isExisting ? (
                      <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                        exists
                      </Badge>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="custom-peer" className="text-xs uppercase text-muted-foreground">
              Or a new name
            </Label>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submit(custom);
              }}
            >
              <Input
                id="custom-peer"
                autoFocus
                value={custom}
                placeholder="e.g. dave"
                onChange={(e) => {
                  setCustom(e.target.value);
                  setError(null);
                }}
              />
              <Button type="submit" variant="default">
                <UserPlus className="h-4 w-4" /> Open
              </Button>
            </form>
            {error ? (
              <p className="text-xs text-destructive">{error}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Master is hard-coded to{" "}
                <span className="font-mono font-semibold">{MASTER_ID}</span>. Choose it
                for this tab, or any other name to join as a peer.
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { MASTER_ID };
