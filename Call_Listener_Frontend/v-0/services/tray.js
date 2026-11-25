// services/tray.js
function makeTrayTemplate({ isActive, onOpen, onToggleRouting, onQuit }) {
  return [
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
