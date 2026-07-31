/**
 * Browser entrypoint: mounts the Showcase page into #root. All content lives in
 * <App/>; this file only owns the DOM handshake.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root element");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
