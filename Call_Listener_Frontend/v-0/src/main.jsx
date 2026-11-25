// FILE: src/main.jsx
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import { UIProvider } from "@/ui/UIContext.jsx";

const root = createRoot(document.getElementById("root"));
root.render(
  <UIProvider>
    <App />
  </UIProvider>
);
