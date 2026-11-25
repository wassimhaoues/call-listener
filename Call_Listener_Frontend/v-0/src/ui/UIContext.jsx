// FILE: src/ui/UIContext.jsx
import React, { createContext, useContext, useEffect, useState } from "react";

const Ctx = createContext(null);

export function UIProvider({ children }) {
  const [theme, setTheme] = useState(
    () => localStorage.getItem("theme") || "light"
  );
  const [title, setTitle] = useState("Call Listener");
  const [actions, setActions] = useState(null); // React node on right side

  useEffect(() => {
    localStorage.setItem("theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));

  return (
    <Ctx.Provider
      value={{ theme, toggleTheme, title, setTitle, actions, setActions }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useUI() {
  return useContext(Ctx);
}
