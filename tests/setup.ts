// Self-registers the Node FS adapter before any test runs. Without this,
// sql-git calls fall through to the "not configured" stubs.
import "../src/fs-node.ts";
