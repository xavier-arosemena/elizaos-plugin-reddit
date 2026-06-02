// =============================================================================
// subscribeReddit.ts — Subscribe Action
//
// Subscribes to or unsubscribes from subreddits within daily limits.
// Resolves subreddit names to fullnames (t5_xxx) via the /api/subscribe endpoint.
// State is persisted to disk for resumption across restarts.
// =============================================================================

import { elizaLogger } from "@elizaos/core";
import type { Action, IAgentRuntime, Memory, State } from "@elizaos/core";
import type { PluginConfig, SubscribeState } from "../types.js";
import { subscribe } from "../lib/redditClient.js";

// =============================================================================
// Constants
// =============================================================================

const STATE_FILE = "reddit_subscribe_state.json";

// =============================================================================
// State persistence
// =============================================================================

function getDataDir(runtime: IAgentRuntime): string {
  return runtime.getSetting("DATA_DIR") ?? "./data";
}

async function loadSubscribeState(runtime: IAgentRuntime): Promise<SubscribeState> {
  try {
    const fs = await import("fs");
    const path = `${getDataDir(runtime)}/${STATE_FILE}`;
    if (fs.existsSync(path)) {
      const raw = fs.readFileSync(path, "utf-8");
      return JSON.parse(raw) as SubscribeState;
    }
  } catch {
    // First run
  }
  return {
    dailyCount: 0,
    dailyDate: new Date().toISOString().slice(0, 10),
    subscribedSubreddits: [],
    unsubscribedSubreddits: [],
  };
}

async function saveSubscribeState(runtime: IAgentRuntime, state: SubscribeState): Promise<void> {
  try {
    const fs = await import("fs");
    const dataDir = getDataDir(runtime);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(`${dataDir}/${STATE_FILE}`, JSON.stringify(state, null, 2), "utf-8");
  } catch (err: any) {
    elizaLogger.error(`[REDDIT-PLUGIN] Failed to save subscribe state: ${err.message}`);
  }
}

// =============================================================================
// Plugin config
// =============================================================================

function createPluginConfig(runtime: IAgentRuntime): PluginConfig {
  return {
    clientId: runtime.getSetting("REDDIT_CLIENT_ID") ?? "",
    clientSecret: runtime.getSetting("REDDIT_CLIENT_SECRET") ?? "",
    username: runtime.getSetting("REDDIT_USERNAME") ?? "",
    password: runtime.getSetting("REDDIT_PASSWORD") ?? "",
    userAgent: runtime.getSetting("REDDIT_USER_AGENT") ?? "elizaos:plugin-reddit:v0.1.0",
    maxUpvotesPerDay: Number(runtime.getSetting("REDDIT_MAX_UPVOTES_PER_DAY") ?? "20"),
    maxUpvotesPerCycle: Number(runtime.getSetting("REDDIT_MAX_UPVOTES_PER_CYCLE") ?? "5"),
    maxRepliesPerDay: Number(runtime.getSetting("REDDIT_MAX_REPLIES_PER_DAY") ?? "10"),
    maxSubscribesPerDay: Number(runtime.getSetting("REDDIT_MAX_SUBSCRIBES_PER_DAY") ?? "5"),
    targetListPath: runtime.getSetting("REDDIT_TARGET_LIST_PATH") ?? "./target_list.md",
    minPostScore: Number(runtime.getSetting("REDDIT_MIN_POST_SCORE") ?? "1"),
    maxOpportunitiesPerCycle: Number(runtime.getSetting("REDDIT_MAX_OPPORTUNITIES") ?? "10"),
    minDelayMs: Number(runtime.getSetting("REDDIT_MIN_DELAY_MS") ?? "2000"),
    maxDelayMs: Number(runtime.getSetting("REDDIT_MAX_DELAY_MS") ?? "8000"),
  };
}

// =============================================================================
// Action
// =============================================================================

export const subscribeRedditAction: Action = {
  name: "SUBSCRIBE_REDDIT",
  similes: [
    "REDDIT_SUBSCRIBE",
    "FOLLOW_REDDIT",
    "REDDIT_FOLLOW",
    "JOIN_REDDIT",
    "REDDIT_JOIN",
    "UNSUBSCRIBE_REDDIT",
    "REDDIT_UNSUBSCRIBE",
    "LEAVE_REDDIT",
    "REDDIT_LEAVE",
  ],
  description:
    "Subscribe to or unsubscribe from subreddits within daily limits. " +
    "Takes a list of subreddit names (with optional action prefix '+sub' or '-unsub'). " +
    "State is persisted to disk for resumption across restarts.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const clientId = runtime.getSetting("REDDIT_CLIENT_ID");
    const clientSecret = runtime.getSetting("REDDIT_CLIENT_SECRET");
    const username = runtime.getSetting("REDDIT_USERNAME");
    const password = runtime.getSetting("REDDIT_PASSWORD");

    if (!clientId || !clientSecret || !username || !password) {
      elizaLogger.warn(`[REDDIT-PLUGIN] SUBSCRIBE_REDDIT validate failed: missing credentials`);
      return false;
    }
    return true;
  },

  handler: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<void> => {
    const startTime = Date.now();
    elizaLogger.info(`[REDDIT-PLUGIN] SUBSCRIBE_REDDIT cycle started`);

    const config = createPluginConfig(runtime);
    const subscribeState = await loadSubscribeState(runtime);
    const today = new Date().toISOString().slice(0, 10);

    // Reset daily counter if day changed
    if (subscribeState.dailyDate !== today) {
      elizaLogger.info(
        `[REDDIT-PLUGIN] Daily subscribe reset: ${subscribeState.dailyDate} → ${today}`
      );
      subscribeState.dailyCount = 0;
      subscribeState.dailyDate = today;
    }

    // Check if daily limit is reached
    if (subscribeState.dailyCount >= config.maxSubscribesPerDay) {
      elizaLogger.warn(
        `[REDDIT-PLUGIN] Daily subscribe limit reached (${subscribeState.dailyCount}/${config.maxSubscribesPerDay})`
      );
      return;
    }

    const remainingBudget = config.maxSubscribesPerDay - subscribeState.dailyCount;

    // Parse the message text for subreddit targets
    // Expected formats:
    //   "+sub europe" or "sub europe" — subscribe to r/europe
    //   "-unsub europe" or "unsub europe" — unsubscribe from r/europe
    //   "europe" — subscribe (default action)
    // Can also be a comma-separated or line-separated list
    const text = message.content?.text ?? "";

    const targets = parseSubscribeTargets(text);

    if (targets.length === 0) {
      elizaLogger.info(`[REDDIT-PLUGIN] No subreddit targets found in message`);
      return;
    }

    const batch = targets.slice(0, remainingBudget);

    elizaLogger.info(
      `[REDDIT-PLUGIN] Processing ${batch.length} subreddit operations (budget: ${remainingBudget})`
    );

    let successCount = 0;
    for (const target of batch) {
      try {
        // Check if already processed
        if (target.action === "sub") {
          if (subscribeState.subscribedSubreddits.includes(target.subreddit)) {
            elizaLogger.info(`[REDDIT-PLUGIN] Already subscribed to r/${target.subreddit} — skipping`);
            continue;
          }
        } else {
          if (subscribeState.unsubscribedSubreddits.includes(target.subreddit)) {
            elizaLogger.info(`[REDDIT-PLUGIN] Already unsubscribed from r/${target.subreddit} — skipping`);
            continue;
          }
        }

        // Reddit's /api/subscribe expects the fullname (t5_xxx), but also accepts the name directly.
        // We use the subreddit name directly — Reddit resolves it.
        const result = await subscribe(config, target.subreddit, target.action);

        if (result) {
          if (target.action === "sub") {
            subscribeState.subscribedSubreddits.push(target.subreddit);
          } else {
            subscribeState.unsubscribedSubreddits.push(target.subreddit);
          }
          subscribeState.dailyCount++;
          successCount++;
        }

        // Polite delay between operations
        const delay = config.minDelayMs + Math.random() * (config.maxDelayMs - config.minDelayMs);
        await new Promise((r) => setTimeout(r, delay));
      } catch (err: any) {
        elizaLogger.error(`[REDDIT-PLUGIN] Failed to ${target.action} r/${target.subreddit}: ${err.message}`);
      }
    }

    // Trim arrays
    if (subscribeState.subscribedSubreddits.length > 500) {
      subscribeState.subscribedSubreddits = subscribeState.subscribedSubreddits.slice(-500);
    }
    if (subscribeState.unsubscribedSubreddits.length > 500) {
      subscribeState.unsubscribedSubreddits = subscribeState.unsubscribedSubreddits.slice(-500);
    }

    await saveSubscribeState(runtime, subscribeState);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    elizaLogger.info(
      `[REDDIT-PLUGIN] SUBSCRIBE_REDDIT cycle completed in ${duration}s — ` +
      `${successCount}/${batch.length} operations ` +
      `(daily: ${subscribeState.dailyCount}/${config.maxSubscribesPerDay})`
    );
  },
};

// =============================================================================
// Target parsing
// =============================================================================

interface SubscribeTarget {
  subreddit: string;
  action: "sub" | "unsub";
}

function parseSubscribeTargets(text: string): SubscribeTarget[] {
  const targets: SubscribeTarget[] = [];
  const seen = new Set<string>();

  // Split by commas, newlines, or semicolons
  const items = text.split(/[\n,;]+/);

  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    let subreddit = trimmed;
    let action: "sub" | "unsub" = "sub";

    // Check for prefix
    const lower = trimmed.toLowerCase();

    if (lower.startsWith("+sub ") || lower.startsWith("sub ")) {
      action = "sub";
      subreddit = trimmed.slice(trimmed.indexOf(" ") + 1).trim();
    } else if (lower.startsWith("-unsub ") || lower.startsWith("unsub ") || lower.startsWith("-sub ")) {
      action = "unsub";
      subreddit = trimmed.slice(trimmed.indexOf(" ") + 1).trim();
    }

    // Clean up subreddit name — remove r/ prefix if present
    subreddit = subreddit.replace(/^r\//, "").replace(/^\/r\//, "");

    // Remove any trailing punctuation
    subreddit = subreddit.replace(/[.,;!?]+$/, "");

    if (!subreddit || subreddit.length === 0) continue;

    // Deduplicate
    const key = `${action}:${subreddit.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    targets.push({ subreddit, action });
  }

  return targets;
}
