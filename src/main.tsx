import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initHistoryLayers } from "./lib/historyLayers";
import "./index.css";

// Stamp the boot entry before first render so Back always has a tagged base.
initHistoryLayers();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
