import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// Intentionally NOT wrapping in StrictMode. StrictMode double-invokes
// effects in dev; our OPFS-backed store's boot effect (Store.open +
// init_bank submit) is not idempotent at the file-log level — the
// second run can race with the first on `peers/<master>.jsonl` and lose
// the init_bank append. Since our effect cleanups already cancel
// in-flight work, keeping StrictMode off in this demo is the narrowly
// correct fix until the Store gets a per-file append mutex.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
