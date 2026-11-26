// services/tray.js
function makeTrayTemplate({ isActive, isInterviewActive = () => false, onOpen, onToggleRouting, onQuit }) {
  const status = isInterviewActive()
    ? [{ label: "Interview in progress — listening", enabled: false }, { type: "separator" }]
    : [];
  return [
    ...status,
    { label: "Open", click: onOpen },
    { type: "separator" },
    {
      label: isActive() ? "Stop Routing" : "Start Routing",
      click: onToggleRouting,
    },
    { type: "separator" },
    { label: "Quit", click: onQuit },
  ];
}

module.exports = { makeTrayTemplate };
