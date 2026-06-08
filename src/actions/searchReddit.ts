// =============================================================================
// searchReddit.ts — 3-Tier Reddit Discovery Action
//
// Tier 1: Keyword-based search across target subreddits
// Tier 2: Monitor subreddit feeds (hot/new) for trending opportunities
// Tier 3: Inbox polling — respond to mentions and replies
//
// Each tier produces ScoredOpportunities. Duplicates are removed across tiers.
// Results are delivered to the Archon agent via /:agentId/ingest endpoint.
// =============================================================================

import { elizaLogger } from "@elizaos/core";
import type { Action, IAgentRuntime, Memory, State } from "@elizaos/core";
import type { PluginConfig, ScoredOpportunity, RedditPost, SearchCycleState } from "../types.js";
import { searchReddit, getSubredditPosts, getInbox } from "../lib/redditClient.js";

// =============================================================================
// Constants
// =============================================================================

const STATE_FILE = "reddit_search_cycle_state.json";
const TARGET_LIST_FILE = "target_list.md";
const DELIVERY_ENDPOINT = "/ingest";

// =============================================================================
// Helpers — state persistence
// =============================================================================

function getDataDir(runtime: IAgentRuntime): string {
  return runtime.getSetting("DATA_DIR") ?? "./data";
}

async function loadSearchState(runtime: IAgentRuntime): Promise<SearchCycleState> {
  try {
    const dataDir = getDataDir(runtime);
    const path = `${dataDir}/${STATE_FILE}`;
    const fs = await import("fs");
    if (fs.existsSync(path)) {
      const raw = fs.readFileSync(path, "utf-8");
      return JSON.parse(raw) as SearchCycleState;
    }
  } catch {
    // File may not exist yet — first run
  }
  return {
    lastCycleTime: 0,
    cycleCount: 0,
    keywordsCache: [],
    keywordsCacheTime: 0,
    processedPostIds: [],
    lastTier2Time: 0,
    lastTier3Time: 0,
  };
}

async function saveSearchState(runtime: IAgentRuntime, state: SearchCycleState): Promise<void> {
  try {
    const dataDir = getDataDir(runtime);
    const fs = await import("fs");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(`${dataDir}/${STATE_FILE}`, JSON.stringify(state, null, 2), "utf-8");
  } catch (err: any) {
    elizaLogger.error(`[REDDIT-PLUGIN] Failed to save search state: ${err.message}`);
  }
}

// =============================================================================
// Plugin config extraction from runtime settings
// =============================================================================

function createPluginConfig(runtime: IAgentRuntime): PluginConfig {
  return {
    clientId: runtime.getSetting("REDDIT_CLIENT_ID") ?? "",
    clientSecret: runtime.getSetting("REDDIT_CLIENT_SECRET") ?? "",
    username: runtime.getSetting("REDDIT_USERNAME") ?? "",
    password: runtime.getSetting("REDDIT_PASSWORD") ?? "",
    userAgent: runtime.getSetting("REDDIT_USER_AGENT") ?? "elizaos:plugin-reddit:v0.1.0 (by /u/Least-Quiet-1305)",
    maxUpvotesPerDay: Number(runtime.getSetting("REDDIT_MAX_UPVOTES_PER_DAY") ?? "20"),
    maxUpvotesPerCycle: Number(runtime.getSetting("REDDIT_MAX_UPVOTES_PER_CYCLE") ?? "5"),
    maxRepliesPerDay: Number(runtime.getSetting("REDDIT_MAX_REPLIES_PER_DAY") ?? "10"),
    maxSubscribesPerDay: Number(runtime.getSetting("REDDIT_MAX_SUBSCRIBES_PER_DAY") ?? "5"),
    targetListPath: runtime.getSetting("REDDIT_TARGET_LIST_PATH") ?? `./${TARGET_LIST_FILE}`,
    minPostScore: Number(runtime.getSetting("REDDIT_MIN_POST_SCORE") ?? "1"),
    maxOpportunitiesPerCycle: Number(runtime.getSetting("REDDIT_MAX_OPPORTUNITIES") ?? "10"),
    minDelayMs: Number(runtime.getSetting("REDDIT_MIN_DELAY_MS") ?? "2000"),
    maxDelayMs: Number(runtime.getSetting("REDDIT_MAX_DELAY_MS") ?? "8000"),
  };
}

// =============================================================================
// Tier 1 — Keyword-based search
// =============================================================================

async function runTier1(
  config: PluginConfig,
  keywords: string[],
  processedIds: Set<string>
): Promise<ScoredOpportunity[]> {
  const opportunities: ScoredOpportunity[] = [];

  elizaLogger.info(`[REDDIT-PLUGIN] Tier 1: Searching ${keywords.length} keywords`);

  for (const keyword of keywords) {
    if (opportunities.length >= config.maxOpportunitiesPerCycle) break;

    try {
      const result = await searchReddit(config, keyword, {
        limit: 5,
        sort: "relevance",
        time: "day",
      });

      if (!result?.posts) continue;

      for (const post of result.posts) {
        const id = post.id;
        if (processedIds.has(id)) continue;
        if (post.stickied) continue;
        if (post.score < config.minPostScore) continue;

        processedIds.add(id);
        opportunities.push({
          post,
          score: scorePost(post, keyword),
          source: "tier1",
          matchedKeyword: keyword,
        });
      }
    } catch (err: any) {
      elizaLogger.error(`[REDDIT-PLUGIN] Tier 1 keyword "${keyword}" error: ${err.message}`);
    }

    // Polite delay between keyword searches
    await sleep(config.minDelayMs + Math.random() * (config.maxDelayMs - config.minDelayMs));
  }

  elizaLogger.info(`[REDDIT-PLUGIN] Tier 1: Found ${opportunities.length} opportunities`);
  return opportunities;
}

// =============================================================================
// Tier 2 — Subreddit feed monitoring
// =============================================================================

async function runTier2(
  config: PluginConfig,
  targetSubreddits: string[],
  processedIds: Set<string>
): Promise<ScoredOpportunity[]> {
  const opportunities: ScoredOpportunity[] = [];

  elizaLogger.info(`[REDDIT-PLUGIN] Tier 2: Monitoring ${targetSubreddits.length} subreddits`);

  for (const subreddit of targetSubreddits) {
    if (opportunities.length >= config.maxOpportunitiesPerCycle) break;

    try {
      const result = await getSubredditPosts(config, subreddit, "new", { limit: 10 });

      if (!result?.posts) continue;

      for (const post of result.posts) {
        const id = post.id;
        if (processedIds.has(id)) continue;
        if (post.stickied) continue;

        processedIds.add(id);

        // Score posts found via feed monitoring — lower confidence than keyword match
        const score = scoreFeedPost(post);
        if (score >= 3) {
          opportunities.push({
            post,
            score,
            source: "tier2",
          });
        }
      }
    } catch (err: any) {
      elizaLogger.error(`[REDDIT-PLUGIN] Tier 2 subreddit "${subreddit}" error: ${err.message}`);
    }

    await sleep(config.minDelayMs + Math.random() * (config.maxDelayMs - config.minDelayMs));
  }

  elizaLogger.info(`[REDDIT-PLUGIN] Tier 2: Found ${opportunities.length} opportunities`);
  return opportunities;
}

// =============================================================================
// Tier 3 — Inbox polling (mentions, replies, messages)
// =============================================================================

async function runTier3(
  config: PluginConfig,
  processedIds: Set<string>
): Promise<ScoredOpportunity[]> {
  const opportunities: ScoredOpportunity[] = [];

  elizaLogger.info(`[REDDIT-PLUGIN] Tier 3: Polling inbox`);

  try {
    const inbox = await getInbox(config, "unread", { limit: 25 });
    if (!inbox?.messages) return opportunities;

    for (const msg of inbox.messages) {
      // Use the message id as dedup key
      const id = `inbox_${msg.id}`;
      if (processedIds.has(id)) continue;
      processedIds.add(id);

      // Create a pseudo-post from the inbox message for uniform handling
      const pseudoPost: RedditPost = {
        id: msg.parentId ?? `inbox_${msg.id}`,
        title: `Inbox: ${msg.kind} from ${msg.author}`,
        selftext: msg.body,
        url: "",
        permalink: msg.context ?? "",
        subreddit: msg.subreddit,
        subreddit_name_prefixed: `r/${msg.subreddit}`,
        author: msg.author,
        created_utc: msg.createdUtc,
        score: 0,
        upvote_ratio: 0,
        num_comments: 0,
        over_18: false,
        spoiler: false,
        stickied: false,
        is_self: true,
        link_flair_text: null,
        link_flair_template_id: null,
        domain: "self.reddit",
        thumbnail: "",
      };

      // Inbox messages always score high — someone is engaging with us
      opportunities.push({
        post: pseudoPost,
        score: 8,
        source: "tier3",
        matchedKeyword: msg.kind,
      });
    }
  } catch (err: any) {
    elizaLogger.error(`[REDDIT-PLUGIN] Tier 3 inbox poll error: ${err.message}`);
  }

  elizaLogger.info(`[REDDIT-PLUGIN] Tier 3: Found ${opportunities.length} inbox items`);
  return opportunities;
}

// =============================================================================
// Scoring helpers
// =============================================================================

/**
 * Score a post found via keyword search (Tier 1).
 * Base score 5, +1 for high comment engagement, +1 for self-text length, etc.
 */
function scorePost(post: RedditPost, _keyword: string): number {
  let score = 5;

  // Bonus for high engagement
  if (post.num_comments > 10) score += 1;
  if (post.num_comments > 50) score += 1;

  // Bonus for substantial self-text (real discussion, not just link)
  if (post.is_self && post.selftext.length > 200) score += 1;

  // Bonus for high upvote ratio (community-endorsed content)
  if (post.upvote_ratio > 0.85) score += 1;

  // Penalty for very low score
  if (post.score < 2) score -= 2;

  return Math.max(1, Math.min(10, score));
}

/**
 * Score a post found via feed monitoring (Tier 2).
 * Lower confidence — base score 3, with engagement bonuses.
 */
function scoreFeedPost(post: RedditPost): number {
  let score = 3;

  if (post.num_comments > 20) score += 1;
  if (post.num_comments > 100) score += 1;
  if (post.upvote_ratio > 0.9) score += 1;
  if (post.is_self && post.selftext.length > 300) score += 1;
  if (post.score > 100) score += 1;
  if (post.score > 1000) score += 1;

  return Math.max(1, Math.min(10, score));
}

/**
 * Simple delay utility.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// =============================================================================
// Target list parsing
// =============================================================================

interface TargetListEntry {
  subreddit: string;
  topic: string;
  postType: string;
  flair: string;
  rules: string;
  status: string;
}

async function parseTargetList(runtime: IAgentRuntime): Promise<{ subreddits: string[]; keywords: string[] }> {
  const config = createPluginConfig(runtime);
  const subreddits: string[] = [];
  const keywords: string[] = [];

  try {
    const fs = await import("fs");
    const path = config.targetListPath;
    if (!fs.existsSync(path)) {
      elizaLogger.warn(`[REDDIT-PLUGIN] Target list not found at ${path} — using defaults`);
      // Default targets if no file exists
      subreddits.push("europe", "worldnews", "technology");
      keywords.push("europe", "eu", "european union");
      return { subreddits, keywords };
    }

    const content = fs.readFileSync(path, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      // Skip headers, comments, and blank lines
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("| --")) continue;

      // Format: subreddit | topic | post_type | flair | rules | status
      const parts = trimmed.split("|").map((p: string) => p.trim());
      if (parts.length < 2) continue;

      const entry: TargetListEntry = {
        subreddit: parts[0],
        topic: parts[1],
        postType: parts[2] ?? "",
        flair: parts[3] ?? "",
        rules: parts[4] ?? "",
        status: parts[5] ?? "active",
      };

      if (entry.status !== "active") continue;

      subreddits.push(entry.subreddit);

      // Derive keywords from the topic
      const topicKeywords = entry.topic
        .toLowerCase()
        .split(/[\s,;]+/)
        .filter((k: string) => k.length > 2);
      keywords.push(...topicKeywords);
    }
  } catch (err: any) {
    elizaLogger.error(`[REDDIT-PLUGIN] Failed to parse target list: ${err.message}`);
    subreddits.push("europe", "worldnews", "technology");
    keywords.push("europe", "eu", "european union");
  }

  return { subreddits, keywords: [...new Set(keywords)] };
}

// =============================================================================
// Delivery to Archon agent
// =============================================================================

async function deliverToArchon(
  opportunities: ScoredOpportunity[],
  runtime: IAgentRuntime
): Promise<void> {
  if (opportunities.length === 0) {
    elizaLogger.info(`[REDDIT-PLUGIN] No opportunities to deliver`);
    return;
  }

  // Format the delivery text
  const lines: string[] = [
    `[SCOUT DELIVERY]`,
    ``,
    `## 🔴 Reddit Discovery Cycle`,
    ``,
    `Found **${opportunities.length}** opportunities across 3 discovery tiers:`,
    ``,
  ];

  // Group by source
  const tier1 = opportunities.filter((o) => o.source === "tier1");
  const tier2 = opportunities.filter((o) => o.source === "tier2");
  const tier3 = opportunities.filter((o) => o.source === "tier3");

  if (tier1.length) {
    lines.push(`### Tier 1 — Keyword Search (${tier1.length})`);
    lines.push(...formatOpportunityList(tier1));
  }

  if (tier2.length) {
    lines.push(`### Tier 2 — Subreddit Feed (${tier2.length})`);
    lines.push(...formatOpportunityList(tier2));
  }

  if (tier3.length) {
    lines.push(`### Tier 3 — Inbox (${tier3.length})`);
    lines.push(...formatOpportunityList(tier3));
  }

  const deliveryText = lines.join("\n");

  try {
    const response = await fetch(
      `http://localhost:${runtime.getSetting("PORT") ?? "3000"}/${runtime.agentId}${DELIVERY_ENDPOINT}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: deliveryText,
          source: "reddit-plugin",
          action: "searchReddit",
        }),
      }
    );

    if (response.ok) {
      elizaLogger.info(
        `[REDDIT-PLUGIN] Delivered ${opportunities.length} opportunities to Archon`
      );
    } else {
      elizaLogger.warn(
        `[REDDIT-PLUGIN] Delivery to Archon returned HTTP ${response.status}`
      );
    }
  } catch (err: any) {
    elizaLogger.warn(
      `[REDDIT-PLUGIN] Delivery to Archon failed (server may not be running): ${err.message}`
    );
  }
}

function formatOpportunityList(opportunities: ScoredOpportunity[]): string[] {
  return opportunities.map((o) => {
    const prefix = o.matchedKeyword ? `[${o.matchedKeyword}] ` : "";
    return [
      `- **Score ${o.score}/10** ${prefix}— [${o.post.title}](${o.post.permalink})`,
      `  r/${o.post.subreddit} by u/${o.post.author} (${o.post.score} pts, ${o.post.num_comments} comments)`,
    ].join("\n");
  });
}

// =============================================================================
// Action definition
// =============================================================================

export const searchRedditAction: Action = {
  name: "SEARCH_REDDIT",
  similes: [
    "REDDIT_SEARCH",
    "SEARCH_REDDIT_CYCLE",
    "DISCOVER_REDDIT",
    "REDDIT_DISCOVERY",
    "SCAN_REDDIT",
  ],
  description:
    "Run a full Reddit discovery cycle: keyword search (Tier 1), subreddit feed monitoring (Tier 2), and inbox polling (Tier 3). Delivers scored opportunities to the Archon agent.",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const clientId = runtime.getSetting("REDDIT_CLIENT_ID");
    const clientSecret = runtime.getSetting("REDDIT_CLIENT_SECRET");
    const username = runtime.getSetting("REDDIT_USERNAME");
    const password = runtime.getSetting("REDDIT_PASSWORD");

    if (!clientId || !clientSecret || !username || !password) {
      elizaLogger.warn(
        `[REDDIT-PLUGIN] SEARCH_REDDIT validate failed: missing Reddit credentials`
      );
      return false;
    }
    return true;
  },

  handler: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<void> => {
    const startTime = Date.now();
    elizaLogger.info(`[REDDIT-PLUGIN] SEARCH_REDDIT cycle started`);

    const config = createPluginConfig(runtime);
    const searchState = await loadSearchState(runtime);
    const processedIds = new Set(searchState.processedPostIds);

    // Parse target list for subreddits and keywords
    const { subreddits, keywords } = await parseTargetList(runtime);

    if (keywords.length === 0) {
      elizaLogger.warn(`[REDDIT-PLUGIN] No keywords available — skipping Tier 1`);
    }

    if (subreddits.length === 0) {
      elizaLogger.warn(`[REDDIT-PLUGIN] No target subreddits — skipping Tier 2`);
    }

    // Run all three tiers
    const [tier1Results, tier2Results, tier3Results] = await Promise.all([
      keywords.length > 0 ? runTier1(config, keywords, processedIds) : Promise.resolve([]),
      subreddits.length > 0 ? runTier2(config, subreddits, processedIds) : Promise.resolve([]),
      runTier3(config, processedIds),
    ]);

    // Merge and deduplicate (by post.id)
    const allOpportunities = [...tier1Results, ...tier2Results, ...tier3Results];
    const seen = new Set<string>();
    const unique = allOpportunities.filter((o) => {
      const key = o.post.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by score descending, take top N
    unique.sort((a, b) => b.score - a.score);
    const topOpportunities = unique.slice(0, config.maxOpportunitiesPerCycle);

    // Update search state
    searchState.lastCycleTime = Date.now();
    searchState.cycleCount++;
    searchState.processedPostIds = Array.from(processedIds).slice(-1000); // keep last 1000

    if (tier1Results.length > 0) searchState.lastTier1Time = Date.now();
    if (tier2Results.length > 0) searchState.lastTier2Time = Date.now();
    if (tier3Results.length > 0) searchState.lastTier3Time = Date.now();

    await saveSearchState(runtime, searchState);

    // Deliver to Archon
    await deliverToArchon(topOpportunities, runtime);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    elizaLogger.info(
      `[REDDIT-PLUGIN] SEARCH_REDDIT cycle completed in ${duration}s — ` +
      `${topOpportunities.length} opportunities delivered ` +
      `(T1: ${tier1Results.length}, T2: ${tier2Results.length}, T3: ${tier3Results.length})`
    );
  },
};
