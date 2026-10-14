import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyLangToDocument } from "./i18n";
import "./index.css";

// 先定下语言：<html lang> 和标题要跟上，晚一步会看到中文标题一闪。
applyLangToDocument();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
