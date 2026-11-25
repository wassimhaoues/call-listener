import { createClient } from "@deepgram/sdk";
import { CONFIG } from "./env.js";

export const deepgram = createClient(CONFIG.DEEPGRAM_API_KEY);
