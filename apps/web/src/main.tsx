import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@sessionbox-killer/ui/tokens.css";
import { App } from "./App";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");

if (!root) {
  throw new Error("Application root is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
