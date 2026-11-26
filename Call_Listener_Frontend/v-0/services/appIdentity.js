// services/appIdentity.js
// Two different identifiers that happen to look alike:
//
// - AUTH_APP_ID is the public application ID sent to the backend's
//   /auth/token (it must equal the backend's APP_ID). It identifies the
//   product to the API, not an installation.
// - WINDOWS_APP_USER_MODEL_ID is the Windows shell identity. electron-builder
//   writes `build.appId` (package.json) into the installed shortcut as its
//   AppUserModelID, so the running app must use exactly the same value, or
//   Windows attributes its notifications and taskbar button to a different
//   app. `test/appIdentity.test.js` keeps the two in sync.

const AUTH_APP_ID = "com.coworky.calllistener";
const WINDOWS_APP_USER_MODEL_ID = "org.coworky.calllistener";

module.exports = { AUTH_APP_ID, WINDOWS_APP_USER_MODEL_ID };
