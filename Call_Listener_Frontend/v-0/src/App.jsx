// FILE: src/App.jsx
import React from "react";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import AppShell from "@/layout/AppShell.jsx";
import Setup from "@/pages/Setup.jsx";
import Context from "@/pages/Context.jsx";
import Conversation from "@/pages/Conversation.jsx";
import AuthError from "@/pages/AuthError.jsx";
import NoVBCable from "@/pages/NoVBCable.jsx";
import Unsupported from "@/pages/Unsupported.jsx";
import Diagnostics from "@/pages/Diagnostics.jsx";
import Connecting from "@/pages/Connecting.jsx";

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Setup />} />
          <Route path="/context" element={<Context />} />
          <Route path="/conversation" element={<Conversation />} />
          <Route path="/autherror" element={<AuthError />} />
          <Route path="/novbcable" element={<NoVBCable />} />
          <Route path="/unsupported" element={<Unsupported />} />
          <Route path="/diagnostics" element={<Diagnostics />} />
          <Route path="/connecting" element={<Connecting />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
