// =============================================================================
// upvoteReddit.ts — UPVOTE_REDDIT ElizaOS Action
//
// Flow:
//   1. Build UpvoteConfig from runtime settings
//   2. Load UpvoteState from disk, check rolling 24h window
//   3. Check daily budget; if exhausted, return early
//   4. Read Scout deliveries from Archon's message memories (ingest endpoint)
//   5. Parse Reddit post URLs from Scout delivery texts, extract post IDs
//   6. Filter already-upvoted post IDs
//   7. UPVOTE Scout-identified posts first (prioritized)
//   8. If batch budget remains, discover more posts:
//      a. Layer 1 — Commenters: get commenters from scout posts, upvote their recent posts
//      b. Layer 2 — Keywords: search for relevant posts using keywords
//   9. Update and persist UpvoteState
//  10. Return formatted cycle results via callback
//
// Logging: All upvote-related logs use [UPVOTE] prefix for grep filtering.
// =============================================================================

import { elizaLogger } from "@elizaos/core";
import type { Action, IAgentRuntime, Memory, State } from "@elizaos/core";
import type { PluginConfig, UpvoteState, RedditPost } from "../types.js";
import { vote, getPostDetails, getUserOverview, searchReddit } from "../lib/redditClient.js";

// =============================================================================
// Constants
// =============================================================================

const STATE_FILE = "reddit_upvote_state.json";
const DEFAULT_MAX_UPVOTES_PER_DAY = 100;
const DEFAULT_MAX_UPVOTES_PER_CYCLE = 20;
const DEFAULT_MIN_DELAY_MS = 2000;
const DEFAULT_MAX_DELAY_MS = 5000;
const MAX_ROLLING_WINDOW = 200;
const BATCH_RANDOMIZE_FRACTION = 0.2; // ±20% jitter on batch size
const MAX_MEMORIES_TO_SCAN = 200;

// Wider Discovery (Issue #8) defaults
const DEFAULT_COMMENTER_DISCOVERY_ENABLED = true;
const DEFAULT_MAX_COMMENTERS_PER_POST = 5;
const DEFAULT_MAX_POSTS_PER_COMMENTER = 3;
const DEFAULT_KEYWORD_DISCOVERY_ENABLED = true;
const DEFAULT_KEYWORD_DISCOVERY_MAX_KEYWORDS = 3;
const DEFAULT_SUBREDDIT_DISCOVERY_ENABLED = false;
const DEFAULT_MAX_POSTS_PER_SUBREDDIT = 5;

// Default keywords for Reddit discovery (policy-relevant topics)
const DEFAULT_KEYWORDS = [
  "EU energy", "European sovereignty", "European Parliament",
  "Austrian economics", "fiscal responsibility", "EU immigration",
  "European right", "crypto regulation EU", "European defense",
  "EU competitiveness", "re-industrialization", "Bitcoin Europe",
  "geopolitical Europe", "energy prices Europe", "European politics",
];

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
      const state = JSON.parse(raw) as UpvoteState;
      // Ensure new fields exist for backward compatibility
      if (state.windowStart === undefined) state.windowStart = Date.now();
      if (state.lastCycleAt === undefined) state.lastCycleAt = "";
      if (state.cycleNumber === undefined) state.cycleNumber = 0;
      return state;
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
    windowStart: Date.now(),
    lastCycleAt: "",
    cycleNumber: 0,
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
    elizaLogger.error(`[UPVOTE] Failed to save upvote state: ${err.message}`);
  }
}

/**
 * Check and reset rolling 24h window.
 * If current time >= windowStart + 24h, reset daily counter.
 */
function checkAndResetWindow(state: UpvoteState): UpvoteState {
  const now = Date.now();
  const windowDuration = 86_400_000; // 24 hours
  if (now - state.windowStart >= windowDuration) {
    elizaLogger.info(
      `[UPVOTE] Rolling window reset — was at ${state.dailyCount}/${state.dailyDate}`
    );
    state.dailyCount = 0;
    state.dailyDate = new Date().toISOString().slice(0, 10);
    state.windowStart = now;
    state.cycleNumber = 0;
    state.rollingWindow = [];
  }
  return state;
}

/**
 * Check if we're within the daily budget.
 */
function isWithinBudget(state: UpvoteState, maxDaily: number): boolean {
  return state.dailyCount < maxDaily;
}

/**
 * Get remaining budget for the day.
 */
function getRemainingBudget(state: UpvoteState, maxDaily: number): number {
  return Math.max(0, maxDaily - state.dailyCount);
}

/**
 * Check if a post ID has already been upvoted (dedup).
 */
function isPostUpvoted(state: UpvoteState, postId: string): boolean {
  return state.upvotedPostIds.includes(postId);
}

/**
 * Record a newly-upvoted post ID.
 */
function recordUpvotedPost(state: UpvoteState, postId: string): void {
  if (!state.upvotedPostIds.includes(postId)) {
    state.upvotedPostIds.push(postId);
    state.rollingWindow.push({ postId, timestamp: Date.now() });

    // Trim rolling window
    if (state.rollingWindow.length > MAX_ROLLING_WINDOW) {
      state.rollingWindow = state.rollingWindow.slice(-MAX_ROLLING_WINDOW);
    }
    // Trim upvotedPostIds to last 1000
    if (state.upvotedPostIds.length > 1000) {
      state.upvotedPostIds = state.upvotedPostIds.slice(-1000);
    }
  }
}

/**
 * Calculate batch budget with randomization for anti-pattern detection.
 */
function calculateBatchBudget(maxDaily: number, remaining: number): number {
  const batchDefault = Math.min(
    Math.ceil(maxDaily / 12),
    remaining
  );
  const jitter = 1 + (Math.random() - 0.5) * 2 * BATCH_RANDOMIZE_FRACTION;
  return Math.max(1, Math.min(remaining, Math.round(batchDefault * jitter)));
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Read Scout delivery texts from Archon's message memory.
 * Scout stores deliveries via POST /{agentId}/ingest using
 * runtime.messageManager.addEmbeddingToMemory() with roomId = runtime.agentId.
 */
async function getScoutDeliveries(runtime: IAgentRuntime): Promise<string[]> {
  const deliveries: string[] = [];

  try {
    const memories = await runtime.messageManager.getMemories({
      roomId: runtime.agentId,
      count: MAX_MEMORIES_TO_SCAN,
    });

    for (const mem of memories) {
      const text = (mem.content as any)?.text ?? "";
      // Scout deliveries start with "[SCOUT DELIVERY]" for Farcaster.
      // Reddit deliveries use "## 🔴 Reddit Discovery Cycle" as header.
      // Also match generic "SCOUT" or "Discovery" patterns.
      if (
        text.includes("[SCOUT DELIVERY]") ||
        text.includes("Reddit Discovery Cycle") ||
        text.includes("Farcaster Discovery Cycle") ||
        text.includes("Found **") && text.includes("opportunities across")
      ) {
        deliveries.push(text);
      }
    }
  } catch (err: any) {
    elizaLogger.warn(
      `[UPVOTE] Could not read Scout deliveries: ${err.message}`
    );
  }

  return deliveries;
}

/**
 * Extract Reddit post fullnames (t3_xxx) from delivery text.
 * Looks for Reddit permalinks like /r/subreddit/comments/postId/...
 */
function extractPostFullnames(deliveries: string[]): string[] {
  const fullnames = new Set<string>();

  // Pattern 1: Reddit permalink in markdown links — [title](/r/sub/comments/postId/...)
  const permalinkRegex = /\/r\/\w+\/comments\/([a-z0-9]+)/gi;
  for (const text of deliveries) {
    let match;
    while ((match = permalinkRegex.exec(text)) !== null) {
      fullnames.add(`t3_${match[1]}`);
    }
  }

  // Pattern 2: Direct t3_ fullnames in text
  const fullnameRegex = /t3_[a-z0-9]+/gi;
  for (const text of deliveries) {
    let match;
    while ((match = fullnameRegex.exec(text)) !== null) {
      fullnames.add(match[0]);
    }
  }

  // Pattern 3: Reddit URL like https://www.reddit.com/r/sub/comments/postId/
  const urlRegex = /reddit\.com\/r\/\w+\/comments\/([a-z0-9]+)/gi;
  for (const text of deliveries) {
    let match;
    while ((match = urlRegex.exec(text)) !== null) {
      fullnames.add(`t3_${match[1]}`);
    }
  }

  return Array.from(fullnames);
}

/**
 * Extract unique subreddit names from delivery text.
 */
function extractSubreddits(deliveries: string[]): string[] {
  const subreddits = new Set<string>();
  const subRegex = /r\/(\w+)/gi;
  for (const text of deliveries) {
    let match;
    while ((match = subRegex.exec(text)) !== null) {
      subreddits.add(match[1]);
    }
  }
  return Array.from(subreddits);
}

/**
 * Extract unique author usernames from delivery text.
 */
function extractAuthors(deliveries: string[]): string[] {
  const authors = new Set<string>();
  const authorRegex = /u\/(\w+)/gi;
  for (const text of deliveries) {
    let match;
    while ((match = authorRegex.exec(text)) !== null) {
      authors.add(match[1]);
    }
  }
  return Array.from(authors);
}

// =============================================================================
// Discovery Layer Functions
// =============================================================================

/**
 * Layer 1 — Commenter Discovery:
 * For each scout-identified post, fetch its comments, extract unique commenters,
 * then fetch recent posts from those commenters.
 *
 * Returns an array of post fullnames that haven't been upvoted yet.
 */
async function getExtraPostsFromCommenters(
  config: PluginConfig,
  scoutPostIds: string[],
  state: UpvoteState,
  maxBudget: number
): Promise<string[]> {
  if (scoutPostIds.length === 0 || maxBudget <= 0) return [];

  const candidatePosts: string[] = [];
  const seenCommenters = new Set<string>();

  for (const postId of scoutPostIds) {
    if (candidatePosts.length >= maxBudget) break;

    try {
      // Fetch post details with comments
      const details = await getPostDetails(config, postId);
      if (!details?.comments) continue;

      const maxCommenters = config.maxCommentersPerPost ?? DEFAULT_MAX_COMMENTERS_PER_POST;

      // Get unique commenter usernames (up to maxCommentersPerPost)
      const commenters = details.comments
        .filter((c) => !c.is_submitter && c.author !== "[deleted]")
        .map((c) => c.author)
        .filter((author) => {
          if (seenCommenters.has(author)) return false;
          seenCommenters.add(author);
          return true;
        })
        .slice(0, maxCommenters);

      for (const commenter of commenters) {
        if (candidatePosts.length >= maxBudget) break;

        try {
          const maxPosts = config.maxPostsPerCommenter ?? DEFAULT_MAX_POSTS_PER_COMMENTER;

          // Fetch recent posts from this commenter
          const overview = await getUserOverview(config, commenter, {
            limit: maxPosts,
            sort: "new",
          });

          if (overview?.posts) {
            for (const post of overview.posts) {
              const fullname = post.id.startsWith("t3_") ? post.id : `t3_${post.id}`;
              if (!isPostUpvoted(state, fullname)) {
                candidatePosts.push(fullname);
                if (candidatePosts.length >= maxBudget) break;
              }
            }
          }

          // Polite delay between API calls
          const delay = config.minDelayMs + Math.random() * (config.maxDelayMs - config.minDelayMs);
          await new Promise((r) => setTimeout(r, delay));
        } catch (err: any) {
          elizaLogger.warn(
            `[UPVOTE] Failed to fetch posts from commenter u/${commenter}: ${err.message}`
          );
        }
      }
    } catch (err: any) {
      elizaLogger.warn(
        `[UPVOTE] Failed to fetch comments for post ${postId}: ${err.message}`
      );
    }
  }

  return candidatePosts;
}

/**
 * Layer 2 — Keyword Discovery:
 * Search Reddit using configured keywords, return posts that haven't been upvoted.
 *
 * Returns an array of post fullnames.
 */
async function getExtraPostsByKeywords(
  config: PluginConfig,
  keywords: string[],
  state: UpvoteState,
  maxBudget: number
): Promise<string[]> {
  if (keywords.length === 0 || maxBudget <= 0) return [];

  const candidatePosts: string[] = [];
  const maxKeywords = config.keywordDiscoveryMaxKeywords ?? DEFAULT_KEYWORD_DISCOVERY_MAX_KEYWORDS;
  const usedKeywords = keywords.slice(0, maxKeywords);

  for (const keyword of usedKeywords) {
    if (candidatePosts.length >= maxBudget) break;

    try {
      const result = await searchReddit(config, keyword, {
        limit: Math.min(10, maxBudget - candidatePosts.length + 5),
        sort: "relevance",
        time: "day",
      });

      if (result?.posts) {
        for (const post of result.posts) {
          const fullname = post.id.startsWith("t3_") ? post.id : `t3_${post.id}`;
          if (!isPostUpvoted(state, fullname) && !candidatePosts.includes(fullname)) {
            candidatePosts.push(fullname);
            if (candidatePosts.length >= maxBudget) break;
          }
        }
      }

      // Polite delay between API calls
      const delay = config.minDelayMs + Math.random() * (config.maxDelayMs - config.minDelayMs);
      await new Promise((r) => setTimeout(r, delay));
    } catch (err: any) {
      elizaLogger.warn(
        `[UPVOTE] Keyword search failed for "${keyword}": ${err.message}`
      );
    }
  }

  return candidatePosts;
}

/**
 * Upvote a batch of posts with polite delays.
 * Returns { liked: number, failed: number, likedIds: string[] }.
 */
async function batchUpvotePosts(
  config: PluginConfig,
  postFullnames: string[],
  minDelayMs: number,
  maxDelayMs: number,
  budget: number
): Promise<{ liked: number; failed: number; likedIds: string[] }> {
  const batch = postFullnames.slice(0, budget);
  let liked = 0;
  let failed = 0;
  const likedIds: string[] = [];

  for (const fullname of batch) {
    try {
      const success = await vote(config, fullname, 1);
      if (success) {
        liked++;
        likedIds.push(fullname);
      } else {
        failed++;
      }

      // Polite delay between votes
      const delay = minDelayMs + Math.random() * (maxDelayMs - minDelayMs);
      await new Promise((r) => setTimeout(r, delay));
    } catch (err: any) {
      elizaLogger.error(`[UPVOTE] Failed to upvote ${fullname}: ${err.message}`);
      failed++;
    }
  }

  return { liked, failed, likedIds };
}

/**
 * Format a human-readable cycle result string.
 */
function formatCycleResult(
  scoutUpvoted: number,
  commenterUpvoted: number,
  keywordUpvoted: number,
  totalUpvoted: number,
  totalFailed: number,
  state: UpvoteState,
  config: PluginConfig,
  cycleNumber: number
): string {
  const totalExtra = commenterUpvoted + keywordUpvoted;
  const lines = [
    `## 👍 Reddit Upvote Cycle #${cycleNumber} Complete`,
    ``,
    `**Summary:** ${totalUpvoted} posts upvoted (${totalFailed} failed)`,
    `- Scout posts: ${scoutUpvoted}`,
    `- Extra (commenters): ${commenterUpvoted}`,
    `- Extra (keywords): ${keywordUpvoted}`,
    `- Total extra: ${totalExtra}`,
    ``,
    `**Daily progress:** ${state.dailyCount}/${config.maxUpvotesPerDay}`,
    `**Total all-time:** ${state.totalUpvoted}`,
  ];
  return lines.join("\n");
}

// =============================================================================
// Config Builder
// =============================================================================

/**
 * Build a PluginConfig with wider discovery settings from runtime env vars.
 */
function createUpvoteConfig(runtime: IAgentRuntime): PluginConfig {
  return {
    clientId: runtime.getSetting("REDDIT_CLIENT_ID") ?? "",
    clientSecret: runtime.getSetting("REDDIT_CLIENT_SECRET") ?? "",
    username: runtime.getSetting("REDDIT_USERNAME") ?? "",
    password: runtime.getSetting("REDDIT_PASSWORD") ?? "",
    userAgent: runtime.getSetting("REDDIT_USER_AGENT") ?? "elizaos:plugin-reddit:v0.1.0",
    maxUpvotesPerDay: Number(runtime.getSetting("REDDIT_MAX_UPVOTES_PER_DAY") ?? String(DEFAULT_MAX_UPVOTES_PER_DAY)),
    maxUpvotesPerCycle: Number(runtime.getSetting("REDDIT_MAX_UPVOTES_PER_CYCLE") ?? String(DEFAULT_MAX_UPVOTES_PER_CYCLE)),
    maxRepliesPerDay: Number(runtime.getSetting("REDDIT_MAX_REPLIES_PER_DAY") ?? "10"),
    maxSubscribesPerDay: Number(runtime.getSetting("REDDIT_MAX_SUBSCRIBES_PER_DAY") ?? "5"),
    targetListPath: runtime.getSetting("REDDIT_TARGET_LIST_PATH") ?? "./target_list.md",
    minPostScore: Number(runtime.getSetting("REDDIT_MIN_POST_SCORE") ?? "1"),
    maxOpportunitiesPerCycle: Number(runtime.getSetting("REDDIT_MAX_OPPORTUNITIES") ?? "10"),
    minDelayMs: Number(runtime.getSetting("UPVOTE_MIN_DELAY_MS") ?? String(DEFAULT_MIN_DELAY_MS)),
    maxDelayMs: Number(runtime.getSetting("UPVOTE_MAX_DELAY_MS") ?? String(DEFAULT_MAX_DELAY_MS)),

    // Wider Discovery (Issue #8)
    commenterDiscoveryEnabled:
      runtime.getSetting("UPVOTE_COMMENTER_DISCOVERY_ENABLED") !== "false"
        ? true
        : DEFAULT_COMMENTER_DISCOVERY_ENABLED,
    maxCommentersPerPost:
      Number(runtime.getSetting("UPVOTE_MAX_COMMENTERS_PER_POST")) || DEFAULT_MAX_COMMENTERS_PER_POST,
    maxPostsPerCommenter:
      Number(runtime.getSetting("UPVOTE_MAX_POSTS_PER_COMMENTER")) || DEFAULT_MAX_POSTS_PER_COMMENTER,
    keywordDiscoveryEnabled:
      runtime.getSetting("UPVOTE_KEYWORD_DISCOVERY_ENABLED") !== "false"
        ? true
        : DEFAULT_KEYWORD_DISCOVERY_ENABLED,
    keywordDiscoveryMaxKeywords:
      Number(runtime.getSetting("UPVOTE_KEYWORD_DISCOVERY_MAX_KEYWORDS")) || DEFAULT_KEYWORD_DISCOVERY_MAX_KEYWORDS,
    subredditDiscoveryEnabled:
      runtime.getSetting("UPVOTE_SUBREDDIT_DISCOVERY_ENABLED") === "true"
        ? true
        : DEFAULT_SUBREDDIT_DISCOVERY_ENABLED,
    maxPostsPerSubreddit:
      Number(runtime.getSetting("UPVOTE_MAX_POSTS_PER_SUBREDDIT")) || DEFAULT_MAX_POSTS_PER_SUBREDDIT,
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
    "Upvote Reddit posts identified by Scout, with wider discovery from commenters and keyword search. " +
    "State is persisted to disk for resumption across restarts. " +
    "Logging uses [UPVOTE] prefix for grep filtering.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const clientId = runtime.getSetting("REDDIT_CLIENT_ID");
    const clientSecret = runtime.getSetting("REDDIT_CLIENT_SECRET");
    const username = runtime.getSetting("REDDIT_USERNAME");
    const password = runtime.getSetting("REDDIT_PASSWORD");

    if (!clientId || !clientSecret || !username || !password) {
      elizaLogger.warn(`[UPVOTE] UPVOTE_REDDIT validate failed: missing credentials`);
      return false;
    }
    return true;
  },

  handler: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<void> => {
    const startTime = Date.now();
    const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

    try {
      // ===================================================================
      // 1. Build config
      // ===================================================================
      const config = createUpvoteConfig(runtime);

      if (!config.clientId || !config.clientSecret) {
        elizaLogger.error("[UPVOTE] ERROR: Reddit API credentials not configured. Cycle aborted.");
        return;
      }

      elizaLogger.info(
        `[UPVOTE] UPVOTE_REDDIT handler START — ${timestamp}, ` +
        `maxDaily=${config.maxUpvotesPerDay}, delay=${config.minDelayMs}-${config.maxDelayMs}ms`
      );

      // ===================================================================
      // 2. Load state & check rolling window
      // ===================================================================
      let upvoteState = await loadUpvoteState(runtime);
      upvoteState = checkAndResetWindow(upvoteState);

      elizaLogger.info(
        `[UPVOTE] State loaded — dailyCount=${upvoteState.dailyCount}/${config.maxUpvotesPerDay}, ` +
        `${upvoteState.upvotedPostIds.length} upvoted posts tracked`
      );

      // ===================================================================
      // 3. Check daily budget
      // ===================================================================
      if (!isWithinBudget(upvoteState, config.maxUpvotesPerDay)) {
        elizaLogger.warn(
          `[UPVOTE] Budget EXHAUSTED — dailyCount=${upvoteState.dailyCount}/${config.maxUpvotesPerDay}. ` +
          `Skipping cycle. Window reset at ${new Date(upvoteState.windowStart + 86400000).toISOString()}.`
        );
        elizaLogger.info(
          `[UPVOTE] Budget EXHAUSTED — daily=${upvoteState.dailyCount}/${config.maxUpvotesPerDay}`
        );
        return;
      }

      // ===================================================================
      // 4. Calculate batch budget
      // ===================================================================
      const remaining = getRemainingBudget(upvoteState, config.maxUpvotesPerDay);
      const batchBudget = calculateBatchBudget(config.maxUpvotesPerDay, remaining);

      elizaLogger.info(
        `[UPVOTE] Budget — daily=${upvoteState.dailyCount}/${config.maxUpvotesPerDay}, ` +
        `remaining=${remaining}, batchBudget=${batchBudget}`
      );

      // ===================================================================
      // 5. Read Scout deliveries from Archon memory
      // ===================================================================
      const scoutDeliveries = await getScoutDeliveries(runtime);
      const postFullnames = extractPostFullnames(scoutDeliveries);

      elizaLogger.info(
        `[UPVOTE] Scout deliveries parsed — ${scoutDeliveries.length} deliveries, ` +
        `${postFullnames.length} post fullnames found`
      );

      // ===================================================================
      // 6. Filter already-upvoted post IDs
      // ===================================================================
      const unlikedScoutPosts = postFullnames.filter(
        (id) => !isPostUpvoted(upvoteState, id)
      );
      const alreadyUpvotedCount = postFullnames.length - unlikedScoutPosts.length;

      elizaLogger.info(
        `[UPVOTE] Scout posts — ${postFullnames.length} total, ` +
        `${unlikedScoutPosts.length} not yet upvoted, ${alreadyUpvotedCount} already upvoted`
      );

      // ===================================================================
      // 7. UPVOTE Scout-identified posts (highest priority)
      // ===================================================================
      const scoutBudget = Math.min(unlikedScoutPosts.length, batchBudget);
      let scoutUpvoted = 0;
      let scoutFailed = 0;
      let totalUpvoted = 0;
      let totalFailed = 0;

      if (scoutBudget > 0) {
        elizaLogger.info(
          `[UPVOTE] Upvoting Scout posts — ${scoutBudget} of ${unlikedScoutPosts.length} unupvoted in this batch`
        );

        const scoutResult = await batchUpvotePosts(
          config,
          unlikedScoutPosts,
          config.minDelayMs,
          config.maxDelayMs,
          scoutBudget
        );

        scoutUpvoted = scoutResult.liked;
        scoutFailed = scoutResult.failed;

        // Update state with Scout upvotes
        for (const id of scoutResult.likedIds) {
          recordUpvotedPost(upvoteState, id);
        }
        upvoteState.dailyCount += scoutUpvoted;
        upvoteState.totalUpvoted += scoutUpvoted;

        totalUpvoted = scoutUpvoted;
        totalFailed = scoutFailed;
      } else {
        elizaLogger.info("[UPVOTE] No unupvoted Scout posts to upvote in this batch");
      }

      // ===================================================================
      // 8a. Layer 1 — Extra posts from commenters of scout posts (Issue #8)
      // ===================================================================
      let remainingBudget = Math.max(0, batchBudget - scoutUpvoted);
      let commenterUpvoted = 0;
      let keywordUpvoted = 0;

      if (remainingBudget > 0 && config.commenterDiscoveryEnabled && postFullnames.length > 0) {
        elizaLogger.info(
          `[UPVOTE] Layer 1 (commenters) — budget=${remainingBudget}, ` +
          `config: maxCommentersPerPost=${config.maxCommentersPerPost ?? DEFAULT_MAX_COMMENTERS_PER_POST}, ` +
          `maxPostsPerCommenter=${config.maxPostsPerCommenter ?? DEFAULT_MAX_POSTS_PER_COMMENTER}`
        );

        // Determine which scout posts to use for commenter discovery
        const scoutPostIds = postFullnames.map((fn) => fn.replace(/^t3_/, ""));

        const commenterPosts = await getExtraPostsFromCommenters(
          { ...config, maxCommentersPerPost: config.maxCommentersPerPost ?? DEFAULT_MAX_COMMENTERS_PER_POST, maxPostsPerCommenter: config.maxPostsPerCommenter ?? DEFAULT_MAX_POSTS_PER_COMMENTER },
          scoutPostIds,
          upvoteState,
          remainingBudget
        );

        if (commenterPosts.length > 0) {
          const commenterCount = Math.min(remainingBudget, commenterPosts.length);

          elizaLogger.info(
            `[UPVOTE] Upvoting extra posts (commenters) — ${commenterCount} of ${commenterPosts.length} candidates`
          );

          const commenterResult = await batchUpvotePosts(
            config,
            commenterPosts,
            config.minDelayMs,
            config.maxDelayMs,
            commenterCount
          );

          commenterUpvoted = commenterResult.liked;

          // Update state with commenter upvotes
          for (const id of commenterResult.likedIds) {
            recordUpvotedPost(upvoteState, id);
          }
          upvoteState.dailyCount += commenterUpvoted;
          upvoteState.totalUpvoted += commenterUpvoted;

          totalUpvoted += commenterUpvoted;
          totalFailed += commenterResult.failed;
          remainingBudget -= commenterUpvoted;
        } else {
          elizaLogger.info("[UPVOTE] Layer 1 (commenters) — no unupvoted posts found");
        }
      } else if (remainingBudget > 0 && !config.commenterDiscoveryEnabled) {
        elizaLogger.info("[UPVOTE] Layer 1 (commenters) — disabled by config");
      }

      // ===================================================================
      // 8b. Layer 2 — Keyword discovery (Issue #8)
      // ===================================================================
      if (remainingBudget > 0 && config.keywordDiscoveryEnabled && (config.keywordDiscoveryMaxKeywords ?? 0) > 0) {
        const maxKeywords = config.keywordDiscoveryMaxKeywords ?? DEFAULT_KEYWORD_DISCOVERY_MAX_KEYWORDS;
        elizaLogger.info(
          `[UPVOTE] Layer 2 (keywords) — budget=${remainingBudget}, ` +
          `maxKeywords=${maxKeywords}`
        );

        const keywordPosts = await getExtraPostsByKeywords(
          { ...config, keywordDiscoveryMaxKeywords: config.keywordDiscoveryMaxKeywords ?? DEFAULT_KEYWORD_DISCOVERY_MAX_KEYWORDS },
          DEFAULT_KEYWORDS,
          upvoteState,
          remainingBudget
        );

        if (keywordPosts.length > 0) {
          const keywordCount = Math.min(remainingBudget, keywordPosts.length);

          elizaLogger.info(
            `[UPVOTE] Upvoting posts (keywords) — ${keywordCount} of ${keywordPosts.length} candidates`
          );

          const keywordResult = await batchUpvotePosts(
            config,
            keywordPosts,
            config.minDelayMs,
            config.maxDelayMs,
            keywordCount
          );

          keywordUpvoted = keywordResult.liked;

          // Update state with keyword upvotes
          for (const id of keywordResult.likedIds) {
            recordUpvotedPost(upvoteState, id);
          }
          upvoteState.dailyCount += keywordUpvoted;
          upvoteState.totalUpvoted += keywordUpvoted;

          totalUpvoted += keywordUpvoted;
          totalFailed += keywordResult.failed;
          remainingBudget -= keywordUpvoted;
        } else {
          elizaLogger.info("[UPVOTE] Layer 2 (keywords) — no relevant posts found");
        }
      } else if (remainingBudget > 0 && !config.keywordDiscoveryEnabled) {
        elizaLogger.info("[UPVOTE] Layer 2 (keywords) — disabled by config");
      }

      // ===================================================================
      // 9. Finalize & persist state
      // ===================================================================
      upvoteState.cycleNumber++;
      upvoteState.lastCycleAt = timestamp;
      await saveUpvoteState(runtime, upvoteState);

      // ===================================================================
      // 10. Build result summary
      // ===================================================================
      const duration = Date.now() - startTime;

      // --- Success log: prominent summary (easy to grep in docker logs) ---
      elizaLogger.success(
        `[UPVOTE] ===== ${totalUpvoted} posts upvoted ===== ` +
        `cycle #${upvoteState.cycleNumber}: ` +
        `scout=${scoutUpvoted}+commenters=${commenterUpvoted}+keywords=${keywordUpvoted}, ` +
        `daily=${upvoteState.dailyCount}/${config.maxUpvotesPerDay}, ` +
        `failed=${totalFailed}, ` +
        `duration=${duration}ms`
      );

      // --- State snapshot for debugging ---
      elizaLogger.info(
        `[UPVOTE] State snapshot — ` +
        `cycle=${upvoteState.cycleNumber}, ` +
        `dailyCount=${upvoteState.dailyCount}/${config.maxUpvotesPerDay}, ` +
        `windowStart=${new Date(upvoteState.windowStart).toISOString()}, ` +
        `totalUpvoted=${upvoteState.totalUpvoted}, ` +
        `lastCycle=${upvoteState.lastCycleAt}`
      );

      return;
    } catch (err: any) {
      const duration = Date.now() - startTime;
      elizaLogger.error(
        `[UPVOTE] UNHANDLED ERROR — ${err.message}\n${err.stack ?? "(no stack)"} (${duration}ms)`
      );
    }
  },

  examples: [],
};
