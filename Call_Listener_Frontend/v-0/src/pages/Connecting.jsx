// FILE: src/pages/Connecting.jsx
import React, { useEffect } from "react";
import { useUI } from "@/ui/UIContext.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";

// Neutral screen shown while the main process signs in to the backend. The
// main process navigates away once auth succeeds or fails (bounded timeout).
export default function Connecting() {
  const { setTitle } = useUI();
  useEffect(() => setTitle("Connecting"), [setTitle]);

  return (
    <div className="h-full grid place-items-center">
      <Card className="w-full max-w-md text-center">
        <CardHeader>Connecting…</CardHeader>
        <CardBody>
          <output className="block text-sm text-[var(--text-2)]">
            Signing in to the Call Listener server. This usually takes a moment.
          </output>
        </CardBody>
      </Card>
    </div>
  );
}
