import { z } from "zod";
import { loggers } from "../../core/logger/index.js";

const ResumeRequestSchema = z.object({
  resume: z.object({
    sessionId: z.string().min(1).max(128),
    lastSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
});

/**
 * Parse a `{ resume: { sessionId, lastSeq } }` frame. Returns null when the
 * frame is not a resume request at all (it is then handled as a normal
 * message), `{ invalid: true }` when it is a malformed one, and the request
 * otherwise.
 */
export function parseResumeRequest(data) {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    return null;
  }
  if (!message || typeof message !== "object" || !Object.hasOwn(message, "resume")) {
    return null;
  }
  const result = ResumeRequestSchema.safeParse(message);
  return result.success ? result.data.resume : { invalid: true };
}

function sendDirect(wsClient, payload) {
  if (wsClient.readyState === wsClient.OPEN) wsClient.send(JSON.stringify(payload));
}

/** Session-lifecycle hooks the message handler calls for `session`. */
function sessionHooks(sessions, session) {
  return {
    onContextAccepted: ({ resume }) => {
      if (resume && sessions.enableResume(session)) {
        session.channel.sendControl({ session: { id: session.id } });
      }
    },
    onEnd: () => sessions.end(session),
  };
}

/**
 * Bind authenticated sockets to sessions. Each connection either resumes an
 * existing session (its first frame is `{ resume }`) or lazily creates a new
 * one on its first other frame. A failed resume (`resume_expired` or
 * `resume_rejected`) keeps the socket open; the client continues on it as a
 * new session by sending its context.
 */
export function createConnectionHandler({
  sessions,
  handleMessage,
  log = loggers.websocket,
} = {}) {
  if (!sessions) throw new TypeError("sessions is required");
  if (typeof handleMessage !== "function") throw new TypeError("handleMessage is required");

  return function handleConnection(wsClient) {
    let session = null;
    let awaitingFirstFrame = true;
    log.info("🎧 New WebSocket client connected");

    function handleResume(request) {
      if (request.invalid) {
        sendDirect(wsClient, { error: "Invalid message" });
        return;
      }
      const result = sessions.resume({ ...request, user: wsClient.user, socket: wsClient });
      if (result.error) {
        sendDirect(wsClient, { error: result.error });
        return;
      }
      session = result.session;
    }

    wsClient.on("message", async (data) => {
      if (awaitingFirstFrame) {
        awaitingFirstFrame = false;
        const request = parseResumeRequest(data);
        if (request) {
          handleResume(request);
          return;
        }
      }
      if (!session) {
        session = sessions.create(wsClient.user, wsClient);
        log.info(`🆕 Session [${session.id}] started`);
      }
      const current = session;
      // A newer connection resumed this session; this socket no longer drives it.
      if (current.socket !== wsClient) return;
      await handleMessage({
        wsClient: current.channel,
        sessionId: current.id,
        data,
        streamManager: current.streamManager,
        ...sessionHooks(sessions, current),
      });
    });

    wsClient.on("close", async () => {
      if (!session) {
        log.info("❌ Client disconnected before starting a session");
        return;
      }
      log.info(`❌ Client disconnected [${session.id}]`);
      try {
        await sessions.disconnect(session, wsClient);
      } catch (error) {
        log.error(`❌ Failed to release session [${session.id}]: %o`, error);
      }
    });

    wsClient.on("error", (err) => {
      log.error(`⚠️ WebSocket error [${session?.id ?? "no session"}]: %o`, err);
    });
  };
}
