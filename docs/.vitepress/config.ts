import { defineConfig } from "vitepress";

// The published site lives at https://WjcmeAFJb.github.io/sql-git/ —
// VitePress needs the repo name as its base so asset URLs and router
// paths resolve to the right subdirectory. Override via DOCS_BASE if
// you're hosting under a different path.
const base = process.env.DOCS_BASE ?? "/sql-git/";

export default defineConfig({
  title: "sql-git",
  description:
    "Distributed SQLite storage with per-peer action logs, master squashing, and rebase-style conflict resolution.",
  base,
  lastUpdated: true,
  cleanUrls: true,
  head: [
    [
      "meta",
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
    ],
  ],
  themeConfig: {
    siteTitle: "sql-git",
    outline: { level: [2, 3] },
    search: { provider: "local" },
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Concepts", link: "/concepts/actions" },
      { text: "API", link: "/api/store" },
      { text: "Demo", link: `${base}demo/`, target: "_blank" },
      {
        text: "GitHub",
        link: "https://github.com/WjcmeAFJb/sql-git",
      },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "Getting started", link: "/guide/getting-started" },
            { text: "Node quickstart", link: "/guide/node" },
            { text: "Browser (OPFS) quickstart", link: "/guide/browser-opfs" },
            { text: "Multi-tab + cross-tab sync", link: "/guide/cross-tab" },
            { text: "Peer-to-peer via Syncthing", link: "/guide/syncthing" },
          ],
        },
      ],
      "/concepts/": [
        {
          text: "Concepts",
          items: [
            { text: "Actions", link: "/concepts/actions" },
            { text: "Master & peers", link: "/concepts/roles" },
            { text: "Sync & rebase", link: "/concepts/sync-and-rebase" },
            { text: "Conflict resolution", link: "/concepts/conflicts" },
            { text: "Convergence detection", link: "/concepts/convergence" },
            { text: "File-sync model", link: "/concepts/file-sync" },
          ],
        },
      ],
      "/api/": [
        {
          text: "API reference",
          items: [
            { text: "Store", link: "/api/store" },
            { text: "FS adapter", link: "/api/fs-adapter" },
            { text: "Conflict resolver", link: "/api/conflict-context" },
            { text: "Types", link: "/api/types" },
          ],
        },
      ],
    },
    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/WjcmeAFJb/sql-git",
      },
    ],
    footer: {
      message: "Released under the project's terms — see repository LICENSE.",
      copyright: "© 2026 sql-git contributors",
    },
  },
});
