import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ATTACH_ACTIVE_TAB_MESSAGE } from "./browser/runtime";
import "./style.css";

void chrome.runtime.sendMessage({ type: ATTACH_ACTIVE_TAB_MESSAGE }).catch(() => {});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
