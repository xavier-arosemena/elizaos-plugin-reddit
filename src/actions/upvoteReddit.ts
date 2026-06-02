// =============================================================================
// upvoteReddit.ts — Upvote Action
//
// Upvotes posts from a provided list, within daily and per-cycle limits.
// State is persisted to disk for resumption across restarts.
// =============================================================================

import { elizaLogger } from "@elizaos/core";
import type { Action, IAgentRuntime, Memory, State } from "@elizaos/core";
import type { PluginConfig, UpvoteState } from "../types.js";
import { vote } from "../lib/redditClient.js";

// =============================================================================
// Constants
// =============================================================================

const STATE_FILE = "reddit_upvote_state.json";
const MAX_ROLLING_WINDOW = 200; // keep last 200 upvote timestamps

// =============================================================================
// State persistence
// =============================================================================

function getDataDir(runtime: IAgentRuntime): string {
  return runtime.getSetting("DATA_DIR") ?? "./data";
}

async function loadUpvoteState(runtime: IAgentRuntime): Promise<UpvoteState> {
  try {
    const fs = await import("fs");
    const path = `${getDataDir(runtime)}/${STATE_FILE}`;
    if (fs.existsSync(path)) {
      const raw = fs.readFileSync(path, "utf-8");
      return JSON.parse(raw) as UpvoteState;
    }
  } catch {
    // First run
  }
  return {
    dailyCount: 0,
    dailyDate: new Date().toISOString().slice(0, 10),
    totalUpvoted: 0,
    upvotedPostIds: [],
    rollingWindow: [],
  };
}

async function saveUpvoteState(runtime: IAgentRuntime, state: UpvoteState): Promise<void> {
  try {
    const fs = await import("fs");
    const dataDir = getDataDir(runtime);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(`${dataDir}/${STATE_FILE}`, JSON.stringify(state, null, 2), "utf-8");
  } catch (err: any) {
    elizaLogger.error(`[REDDIT-PLUGIN] Failed to save upvote state: ${err.message}`);
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

export const upvoteRedditAction: Action = {
  name: "UPVOTE_REDDIT",
  similes: [
    "REDDIT_UPVOTE",
    "LIKE_REDDIT",
    "REDDIT_LIKE",
    "VOTE_REDDIT",
  ],
  description:
    "Upvote Reddit posts from a provided list, respecting daily and per-cycle limits. " +
    "State is persisted to disk for resumption across restarts.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const clientId = runtime.getSetting("REDDIT_CLIENT_ID");
    const clientSecret = runtime.getSetting("REDDIT_CLIENT_SECRET");
    const username = runtime.getSetting("REDDIT_USERNAME");
    const password = runtime.getSetting("REDDIT_PASSWORD");

    if (!clientId || !clientSecret || !username || !password) {
      elizaLogger.warn(`[REDDIT-PLUGIN] UPVOTE_REDDIT validate failed: missing credentials`);
      return false;
    }
    return true;
  },

  handler: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<void> => {
    const startTime = Date.now();
    elizaLogger.info(`[REDDIT-PLUGIN] UPVOTE_REDDIT cycle started`);

    const config = createPluginConfig(runtime);
    const upvoteState = await loadUpvoteState(runtime);
    const today = new Date().toISOString().slice(0, 10);

    // Reset daily counter if day changed
    if (upvoteState.dailyDate !== today) {
      elizaLogger.info(
        `[REDDIT-PLUGIN] Daily upvote reset: ${upvoteState.dailyDate} → ${today}`
      );
      upvoteState.dailyCount = 0;
      upvoteState.dailyDate = today;
      upvoteState.rollingWindow = [];
    }

    // Check if daily limit is reached
    if (upvoteState.dailyCount >= config.maxUpvotesPerDay) {
      elizaLogger.warn(
        `[REDDIT-PLUGIN] Daily upvote limit reached (${upvoteState.dailyCount}/${config.maxUpvotesPerDay})`
      );
      return;
    }

    // Calculate remaining budget for this cycle
    const remainingDaily = config.maxUpvotesPerDay - upvoteState.dailyCount;
    const cycleBudget = Math.min(config.maxUpvotesPerCycle, remainingDaily);

    if (cycleBudget <= 0) {
      elizaLogger.info(`[REDDIT-PLUGIN] No upvote budget remaining this cycle`);
      return;
    }

    // Parse the message text for post IDs to upvote
    // Expected format: "Upvote these posts: t3_abc123, t3_def456"
    // Alternatively, the message contains a list of fullnames
    const text = message.content?.text ?? "";
    const fullnameRegex = /t3_[a-z0-9]+/gi;
    const matches = text.match(fullnameRegex);

    if (!matches || matches.length === 0) {
      elizaLogger.info(`[REDDIT-PLUGIN] No post fullnames found in message to upvote`);
      return;
    }

    // Filter out already-upvoted posts
    const toUpvote = matches.filter((id) => !upvoteState.upvotedPostIds.includes(id));
    const batch = toUpvote.slice(0, cycleBudget);

    elizaLogger.info(
      `[REDDIT-PLUGIN] Upvoting ${batch.length} posts (budget: ${cycleBudget}, already upvoted: ${matches.length - toUpvote.length})`
    );

    let successCount = 0;
    for (const fullname of batch) {
      try {
        const success = await vote(config, fullname, 1);

        if (success) {
          upvoteState.dailyCount++;
          upvoteState.totalUpvoted++;
          upvoteState.upvotedPostIds.push(fullname);
          upvoteState.rollingWindow.push({
            postId: fullname,
            timestamp: Date.now(),
          });
          successCount++;
        }

        // Polite delay between votes
        const delay = config.minDelayMs + Math.random() * (config.maxDelayMs - config.minDelayMs);
        await new Promise((r) => setTimeout(r, delay));
      } catch (err: any) {
        elizaLogger.error(`[REDDIT-PLUGIN] Failed to upvote ${fullname}: ${err.message}`);
      }
    }

    // Trim rolling window to max size
    if (upvoteState.rollingWindow.length > MAX_ROLLING_WINDOW) {
      upvoteState.rollingWindow = upvoteState.rollingWindow.slice(-MAX_ROLLING_WINDOW);
    }

    // Trim upvotedPostIds to last 1000
    if (upvoteState.upvotedPostIds.length > 1000) {
      upvoteState.upvotedPostIds = upvoteState.upvotedPostIds.slice(-1000);
    }

    await saveUpvoteState(runtime, upvoteState);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    elizaLogger.info(
      `[REDDIT-PLUGIN] UPVOTE_REDDIT cycle completed in ${duration}s — ` +
      `${successCount}/${batch.length} upvoted ` +
      `(daily: ${upvoteState.dailyCount}/${config.maxUpvotesPerDay}, total: ${upvoteState.totalUpvoted})`
    );
  },
};
