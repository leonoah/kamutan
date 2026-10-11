import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { applyDocumentDirection } from "./i18n";
import { applyTheme, useThemeStore } from "./stores/themeStore";
import { App } from "./App";

applyDocumentDirection();
applyTheme(useThemeStore.getState().pref);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
