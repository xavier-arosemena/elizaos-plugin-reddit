// =============================================================================
// index.ts — Reddit Plugin Entry Point
//
// Registers all Reddit actions with ElizaOS AgentRuntime.
//
// Actions:
//   1. searchReddit  — 3-tier discovery (keyword search, subreddit feeds, inbox)
//   2. upvoteReddit  — upvote relevant posts within daily limits
//   3. replyReddit   — reply to posts/comments within daily limits
//   4. subscribeReddit — subscribe/unsubscribe to subreddits
// =============================================================================

import type { Plugin } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import { searchRedditAction } from "./actions/searchReddit.js";
import { upvoteRedditAction } from "./actions/upvoteReddit.js";
import { replyRedditAction } from "./actions/replyReddit.js";
import { subscribeRedditAction } from "./actions/subscribeReddit.js";

export const redditPlugin: Plugin = {
  name: "reddit",
  description: "Reddit integration plugin — search, engage, and manage Reddit interactions",

  actions: [
    searchRedditAction,
    upvoteRedditAction,
    replyRedditAction,
    subscribeRedditAction,
  ],

  // Providers and evaluators can be added here in future iterations
  providers: [],
  evaluators: [],
};

// Plugin loaded log
elizaLogger.info(`[REDDIT-PLUGIN] Reddit plugin loaded — ${redditPlugin.actions.length} actions registered`);

export default redditPlugin;
