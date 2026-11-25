// FILE: src/pages/NoVBCable.jsx
import React, { useEffect } from "react";
import { useUI } from "@/ui/UIContext.jsx";
import { Card, CardBody, CardHeader } from "@/components/ui/Card.jsx";

export default function NoVBCable() {
  const { setTitle } = useUI();
  useEffect(() => setTitle("Audio Device Check"), [setTitle]);

  return (
    <div className="h-full grid place-items-center">
      <Card className="w-full h-full flex flex-col">
        <CardHeader>No VB-Cable Detected</CardHeader>
        <CardBody>
          <p className="text-sm text-[var(--text-2)]">
            Please ensure that <strong>VB-Cable</strong> is installed and
            configured correctly.
          </p>
          <p className="mt-3">
            Download from the official website:&nbsp;
            <a
              className="text-[var(--accent)] underline"
              href="https://www.vb-audio.com/Cable/"
              target="_blank"
              rel="noreferrer"
            >
              VB-Audio Cable
            </a>
          </p>
          <p className="mt-2 text-sm text-[var(--text-2)]">
            Once VB-Cable is set up, please reopen the app to detect the device.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
