import { loggers } from "../../core/logger/index.js";
import { createSessionId } from "./sessionId.js";
import { SessionChannel } from "./sessionChannel.js";

export const DEFAULT_RESUME_WINDOW_MS = 120_000;

export const SESSION_STATE = Object.freeze({
  ACTIVE: "active",
  DISCONNECTED: "disconnected",
  ENDED: "ended",
  EXPIRED: "expired",
});

export const RESUME_ERROR = Object.freeze({
  EXPIRED: "resume_expired",
  REJECTED: "resume_rejected",
});

/** Close code sent to a socket whose session was resumed on a newer connection. */
export const SESSION_TAKEN_OVER_CLOSE_CODE = 4002;

function toOwner(user) {
  return {
    appId: typeof user?.app_id === "string" ? user.app_id : "",
    deviceId: typeof user?.device_id === "string" ? user.device_id : "",
  };
}

function isSameOwner(a, b) {
  return Boolean(a.appId && a.deviceId) && a.appId === b.appId && a.deviceId === b.deviceId;
}

/** Opt a session into sequencing and resume. Returns true the first time only. */
function enableResume(session) {
  if (session.resumable) return false;
  session.resumable = true;
  session.channel.enableSequencing();
  return true;
}

/**
 * In-memory registry of live interview sessions and their lifecycle:
 *
 *   active ──socket close──▶ disconnected ──resume──▶ active
 *      │                          │
 *      └──{ end: true }──▶ ended  └──resume window elapses──▶ expired
 *
 * Only sessions whose client advertised the `resume` capability enter
 * `disconnected`; every other session is torn down and purged on socket close
 * exactly as before. Ended and expired sessions are purged and forgotten.
 *
 * State is per process: a multi-instance deployment needs shared session and
 * replay storage plus sticky routing before resume works across instances.
 */
export function createSessionManager({
  createStreamManager,
  purgeSession,
  resumeWindowMs = DEFAULT_RESUME_WINDOW_MS,
  replayLimits,
  createId = createSessionId,
  timers = { setTimeout, clearTimeout },
  log = loggers.websocket,
} = {}) {
  if (typeof createStreamManager !== "function") {
    throw new TypeError("createStreamManager is required");
  }
  if (typeof purgeSession !== "function") {
    throw new TypeError("purgeSession is required");
  }
  if (!Number.isFinite(resumeWindowMs) || resumeWindowMs < 0) {
    throw new TypeError("resumeWindowMs must be a non-negative number");
  }

  const sessions = new Map();

  function newUniqueId() {
    let id = createId();
    while (sessions.has(id)) id = createId();
    return id;
  }

  function create(user, socket) {
    const id = newUniqueId();
    const channel = new SessionChannel({ replayLimits });
    channel.attach(socket);
    const session = {
      id,
      owner: toOwner(user),
      state: SESSION_STATE.ACTIVE,
      resumable: false,
      socket,
      channel,
      streamManager: createStreamManager(id),
      expiryTimer: null,
    };
    sessions.set(id, session);
    return session;
  }

  function clearExpiry(session) {
    if (session.expiryTimer) timers.clearTimeout(session.expiryTimer);
    session.expiryTimer = null;
  }

  async function finish(session, state) {
    session.state = state;
    clearExpiry(session);
    sessions.delete(session.id);
    await session.streamManager.closeAll();
    await purgeSession(session.id);
  }

  /** Explicit `{ end: true }`: a resumable session ends and is purged now. */
  async function end(session) {
    if (!session.resumable) return;
    await finish(session, SESSION_STATE.ENDED);
    log.info(`🛑 Session [${session.id}] ended and purged.`);
  }

  async function expire(session) {
    if (session.state !== SESSION_STATE.DISCONNECTED) return;
    try {
      await finish(session, SESSION_STATE.EXPIRED);
      log.info(`⌛ Resume window elapsed; session [${session.id}] purged.`);
    } catch (error) {
      log.error(`❌ Failed to purge expired session [${session.id}]: %o`, error);
    }
  }

  function startResumeWindow(session) {
    session.state = SESSION_STATE.DISCONNECTED;
    clearExpiry(session);
    session.expiryTimer = timers.setTimeout(() => {
      void expire(session);
    }, resumeWindowMs);
    session.expiryTimer?.unref?.();
  }

  /**
   * Detach the socket from a resumable session without ending it: pause
   * transcription and model work, then hold the session for the resume window.
   */
  function suspend(session) {
    session.socket = null;
    session.channel.detach();
    startResumeWindow(session);
    return session.streamManager.pause();
  }

  /** The socket bound to `session` closed. Stale sockets (already replaced) are ignored. */
  async function disconnect(session, socket) {
    if (session.socket !== socket) return;
    if (!session.resumable || session.state !== SESSION_STATE.ACTIVE) {
      session.socket = null;
      session.channel.detach();
      await finish(session, SESSION_STATE.ENDED);
      return;
    }
    log.info(`⏸️ Session [${session.id}] disconnected; resumable for ${resumeWindowMs} ms.`);
    await suspend(session);
  }

  function takeOver(session, socket) {
    const previous = session.socket;
    if (!previous || previous === socket) return;
    void suspend(session).catch((error) => {
      log.error(`❌ Failed to pause session [${session.id}]: %o`, error);
    });
    try {
      previous.close(SESSION_TAKEN_OVER_CLOSE_CODE, "session_resumed_elsewhere");
    } catch {}
  }

  /**
   * Rebind `socket` to an existing session. Unknown, ended, expired, or
   * non-resumable sessions answer `resume_expired`; a different owner answers
   * `resume_rejected` and leaves the session untouched.
   */
  function resume({ sessionId, lastSeq, user, socket }) {
    const session = sessions.get(sessionId);
    if (!session?.resumable) return { error: RESUME_ERROR.EXPIRED };
    if (!isSameOwner(session.owner, toOwner(user))) {
      log.warn(`🚫 Resume rejected for session [${sessionId}]: owner mismatch`);
      return { error: RESUME_ERROR.REJECTED };
    }
    takeOver(session, socket);
    clearExpiry(session);
    session.state = SESSION_STATE.ACTIVE;
    session.socket = socket;
    session.channel.attach(socket);
    const { replayed, truncated } = session.channel.replaySince(lastSeq);
    const resumed = { sessionId, seq: session.channel.seq };
    if (truncated) resumed.truncated = true;
    session.channel.sendControl({ resumed });
    // Audio captured while disconnected never reached the server.
    session.channel.sendControl({ notice: "audio_gap" });
    log.info(`▶️ Session [${sessionId}] resumed; replayed ${replayed} message(s).`);
    return { session };
  }

  return {
    create,
    enableResume,
    resume,
    disconnect,
    end,
    get: (id) => sessions.get(id),
    get size() {
      return sessions.size;
    },
  };
}
