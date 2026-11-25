import { createServiceLogger } from "./loggerFactory.js";

export const loggers = {
  core: createServiceLogger("core"),
  ai: createServiceLogger("ai"),
  deepgram: createServiceLogger("deepgram"),
  websocket: createServiceLogger("websocket"),
  redis: createServiceLogger("redis"),
  chat: createServiceLogger("chat"), 
};
