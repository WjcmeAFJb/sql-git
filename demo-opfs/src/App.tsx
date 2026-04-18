import { useCallback, useEffect, useRef, useState } from "react";
import {
  File as FileIcon,
  Folder,
  FolderOpen,
  Pencil,
  Plus,
  RefreshCcw,
  Save,
  Trash2,
} from "lucide-react";
import { createOpfsFs, type OpfsFs } from "../../src/fs-opfs";
import type { FsEvent } from "../../src/fs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const ROOT_NAME = "opfs-demo";

type Entry = { name: string; path: string; kind: "file" | "dir" };

async function listTree(
  opfs: OpfsFs,
  dir: string,
): Promise<{ files: Entry[]; dirs: Entry[] }> {
  const names = await opfs.fs.readdir(dir);
  const files: Entry[] = [];
  const dirs: Entry[] = [];
  for (const name of names) {
    const path = opfs.path.join(dir, name);
    // Cheapest cross-browser way to distinguish: try readdir; if it works,
    // it's a directory. Slightly wasteful but fine at demo scale.
    try {
      await opfs.fs.readdir(path);
      dirs.push({ name, path, kind: "dir" });
    } catch {
      files.push({ name, path, kind: "file" });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { files, dirs };
}

type TreeNode = {
  entry: Entry;
  children?: TreeNode[];
};

async function buildTree(opfs: OpfsFs, dir: string): Promise<TreeNode[]> {
  const { files, dirs } = await listTree(opfs, dir);
  const nodes: TreeNode[] = [];
  for (const d of dirs) {
    nodes.push({ entry: d, children: await buildTree(opfs, d.path) });
  }
  for (const f of files) nodes.push({ entry: f });
  return nodes;
}

function TreeView({
  nodes,
  selected,
  onSelect,
  depth = 0,
}: {
  nodes: TreeNode[];
  selected: string | null;
  onSelect: (e: Entry) => void;
  depth?: number;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <ul className="text-sm">
      {nodes.map((n) => {
        const isOpen = open[n.entry.path] ?? true;
        const isSelected = selected === n.entry.path;
        return (
          <li key={n.entry.path}>
            <button
              onClick={() => {
                onSelect(n.entry);
                if (n.entry.kind === "dir") {
                  setOpen((s) => ({ ...s, [n.entry.path]: !isOpen }));
                }
              }}
              className={cn(
                "flex w-full items-center gap-1 rounded px-2 py-0.5 text-left hover:bg-accent",
                isSelected && "bg-accent text-accent-foreground",
              )}
              style={{ paddingLeft: depth * 12 + 8 }}
            >
              {n.entry.kind === "dir" ? (
                isOpen ? (
                  <FolderOpen className="h-4 w-4 shrink-0 text-amber-400" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0 text-amber-400" />
                )
              ) : (
                <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{n.entry.name}</span>
            </button>
            {n.entry.kind === "dir" && isOpen && n.children ? (
              <TreeView
                nodes={n.children}
                selected={selected}
                onSelect={onSelect}
                depth={depth + 1}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export default function App() {
  const opfsRef = useRef<OpfsFs | null>(null);
  const [ready, setReady] = useState(false);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [content, setContent] = useState("");
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [events, setEvents] = useState<Array<FsEvent & { at: number; origin: "local" | "remote" }>>([]);
  const [status, setStatus] = useState<string>("");
  const [tabId] = useState(() =>
    Math.random().toString(36).slice(2, 7).toUpperCase(),
  );

  const refresh = useCallback(async () => {
    const opfs = opfsRef.current;
    if (!opfs) return;
    setTree(await buildTree(opfs, "/"));
  }, []);

  const canSave = selected?.kind === "file" && selected.path === loadedPath;

  useEffect(() => {
    (async () => {
      const opfs = createOpfsFs();
      await opfs.init({ rootName: ROOT_NAME });
      // Seed a demo layout on first visit so the tree isn't empty.
      if (!(await opfs.fs.exists("/notes"))) {
        await opfs.fs.mkdirp("/notes");
        await opfs.fs.writeFile(
          "/notes/readme.md",
          "# OPFS demo\n\nEdit this file in one tab, open another tab at the same URL, watch the event log update cross-tab.\n",
        );
        await opfs.fs.writeFile("/notes/todo.txt", "- try renaming me\n- try deleting me\n");
      }
      opfsRef.current = opfs;
      const unsub = opfs.fs.watch("/", (e, origin) => {
        setEvents((prev) =>
          [{ ...e, at: Date.now(), origin }, ...prev].slice(0, 50),
        );
        void refresh();
      });
      await refresh();
      setReady(true);
      return () => {
        unsub();
        opfs.close();
      };
    })().catch((err) => {
      setStatus(String(err));
    });
  }, [refresh]);

  const loadSelected = useCallback(async (entry: Entry) => {
    if (entry.kind !== "file") {
      setContent("");
      setLoadedPath(null);
      return;
    }
    const opfs = opfsRef.current!;
    try {
      const text = await opfs.fs.readTextFile(entry.path);
      setContent(text);
      setLoadedPath(entry.path);
    } catch (err) {
      setStatus(String(err));
    }
  }, []);

  const onSelect = (entry: Entry) => {
    setSelected(entry);
    setRenaming(false);
    void loadSelected(entry);
  };

  const save = async () => {
    if (!selected || selected.kind !== "file") return;
    const opfs = opfsRef.current!;
    await opfs.fs.writeFile(selected.path, content);
    setStatus(`saved ${selected.path}`);
  };

  const newFile = async () => {
    const opfs = opfsRef.current!;
    const dirPath =
      selected?.kind === "dir"
        ? selected.path
        : selected
          ? opfs.path.dirname(selected.path)
          : "/";
    const name = prompt("File name:", "untitled.txt");
    if (!name) return;
    const p = opfs.path.join(dirPath, name);
    await opfs.fs.writeFile(p, "");
    setStatus(`created ${p}`);
  };

  const newFolder = async () => {
    const opfs = opfsRef.current!;
    const dirPath =
      selected?.kind === "dir"
        ? selected.path
        : selected
          ? opfs.path.dirname(selected.path)
          : "/";
    const name = prompt("Folder name:", "new-folder");
    if (!name) return;
    const p = opfs.path.join(dirPath, name);
    await opfs.fs.mkdirp(p);
    setStatus(`created dir ${p}`);
  };

  const startRename = () => {
    if (!selected) return;
    setRenaming(true);
    setRenameValue(selected.name);
  };

  const commitRename = async () => {
    if (!selected) return;
    const opfs = opfsRef.current!;
    const parent = opfs.path.dirname(selected.path);
    const dst = opfs.path.join(parent, renameValue.trim());
    if (!renameValue.trim() || dst === selected.path) {
      setRenaming(false);
      return;
    }
    await opfs.fs.rename(selected.path, dst);
    setStatus(`renamed to ${dst}`);
    setSelected({ ...selected, name: renameValue.trim(), path: dst });
    setLoadedPath((p) => (p === selected.path ? dst : p));
    setRenaming(false);
  };

  const removeSelected = async () => {
    if (!selected) return;
    const opfs = opfsRef.current!;
    await opfs.fs.remove!(selected.path);
    setStatus(`deleted ${selected.path}`);
    setSelected(null);
    setLoadedPath(null);
    setContent("");
    await refresh();
  };

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        initializing OPFS… {status ? <span className="ml-2 text-destructive">{status}</span> : null}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <div>
          <h1 className="text-base font-semibold">OPFS adapter demo</h1>
          <p className="text-xs text-muted-foreground">
            tab <span className="font-mono">{tabId}</span> · root{" "}
            <span className="font-mono">/{ROOT_NAME}</span> · open this URL in
            another tab to see cross-tab watch
          </p>
        </div>
        <div className="text-xs text-muted-foreground">{status}</div>
      </header>

      <div className="grid flex-1 min-h-0 grid-cols-[260px_1fr_280px]">
        <aside className="flex flex-col border-r">
          <div className="flex items-center gap-1 border-b p-2">
            <Button size="sm" variant="outline" onClick={newFile}>
              <Plus className="h-3 w-3" /> File
            </Button>
            <Button size="sm" variant="outline" onClick={newFolder}>
              <Plus className="h-3 w-3" /> Dir
            </Button>
            <Button size="icon" variant="ghost" onClick={() => void refresh()} title="Refresh">
              <RefreshCcw className="h-3 w-3" />
            </Button>
          </div>
          <div className="flex-1 overflow-auto p-1">
            {tree.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">empty</p>
            ) : (
              <TreeView nodes={tree} selected={selected?.path ?? null} onSelect={onSelect} />
            )}
          </div>
        </aside>

        <main className="flex min-w-0 flex-col">
          <div className="flex items-center justify-between gap-2 border-b p-2">
            <div className="flex min-w-0 items-center gap-2">
              {renaming ? (
                <>
                  <Input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename();
                      if (e.key === "Escape") setRenaming(false);
                    }}
                    className="h-7 w-64"
                  />
                  <Button size="sm" onClick={() => void commitRename()}>
                    rename
                  </Button>
                </>
              ) : (
                <span className="truncate font-mono text-sm">
                  {selected?.path ?? "— select a file —"}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" disabled={!selected} onClick={startRename}>
                <Pencil className="h-3 w-3" /> Rename
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={!selected}
                onClick={() => void removeSelected()}
              >
                <Trash2 className="h-3 w-3" /> Delete
              </Button>
              <Button
                size="sm"
                disabled={!canSave}
                onClick={() => void save()}
              >
                <Save className="h-3 w-3" /> Save
              </Button>
            </div>
          </div>

          {selected?.kind === "file" ? (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="flex-1 resize-none bg-background p-3 font-mono text-sm outline-none"
              spellCheck={false}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              {selected?.kind === "dir"
                ? "directory — select a file"
                : "select a file to edit"}
            </div>
          )}
        </main>

        <aside className="flex flex-col border-l">
          <h2 className="border-b p-2 text-sm font-semibold">Watch events</h2>
          <div className="flex-1 overflow-auto">
            {events.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                no events yet — try editing a file here or in another tab
              </p>
            ) : (
              <ul className="divide-y text-xs font-mono">
                {events.map((e, i) => (
                  <li key={i} className="p-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "rounded px-1 text-[10px] uppercase",
                          e.origin === "local"
                            ? "bg-secondary text-secondary-foreground"
                            : "bg-amber-500/20 text-amber-400",
                        )}
                      >
                        {e.origin}
                      </span>
                      <span className="font-semibold">{e.type}</span>
                      <span className="ml-auto text-muted-foreground">
                        {new Date(e.at).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-muted-foreground">
                      {"path" in e ? e.path : `${e.from} → ${e.to}`}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
