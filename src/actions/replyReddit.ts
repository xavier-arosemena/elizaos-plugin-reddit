// =============================================================================
// replyReddit.ts — Reply Action
//
// Replies to Reddit posts and comments within daily limits.
// Uses ElizaOS LLM to generate context-aware replies based on character config.
// State is persisted to disk for resumption across restarts.
// =============================================================================

import { elizaLogger, composeContext, generateMessageResponse, ModelClass } from "@elizaos/core";
import type { Action, IAgentRuntime, Memory, State } from "@elizaos/core";
import type { PluginConfig, ReplyState } from "../types.js";
import { reply, getPostDetails } from "../lib/redditClient.js";

// =============================================================================
// Constants
// =============================================================================

const STATE_FILE = "reddit_reply_state.json";

// =============================================================================
// State persistence
// =============================================================================

function getDataDir(runtime: IAgentRuntime): string {
  return runtime.getSetting("DATA_DIR") ?? "./data";
}

async function loadReplyState(runtime: IAgentRuntime): Promise<ReplyState> {
  try {
    const fs = await import("fs");
    const path = `${getDataDir(runtime)}/${STATE_FILE}`;
    if (fs.existsSync(path)) {
      const raw = fs.readFileSync(path, "utf-8");
      return JSON.parse(raw) as ReplyState;
    }
  } catch {
    // First run
  }
  return {
    dailyCount: 0,
    dailyDate: new Date().toISOString().slice(0, 10),
    totalReplies: 0,
    repliedPostIds: [],
    processedCommentIds: [],
  };
}

async function saveReplyState(runtime: IAgentRuntime, state: ReplyState): Promise<void> {
  try {
    const fs = await import("fs");
    const dataDir = getDataDir(runtime);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(`${dataDir}/${STATE_FILE}`, JSON.stringify(state, null, 2), "utf-8");
  } catch (err: any) {
    elizaLogger.error(`[REDDIT-PLUGIN] Failed to save reply state: ${err.message}`);
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
// Reply generation context template
// =============================================================================

const replyTemplate = `
# Context
You are replying to a Reddit post or comment as {{agentName}}.

## Post/Comment Content
{{postContent}}

## Subreddit
{{subreddit}}

## Instructions
Write a thoughtful, on-topic reply that adds value to the discussion. Follow these rules:

1. Be concise — 2-4 sentences maximum
2. Be respectful and constructive
3. Stay on-topic — don't promote unrelated content
4. Don't mention you're a bot or AI
5. Use natural, conversational language
6. Don't include links unless directly relevant to the discussion
7. Match the tone of the subreddit

Generate only the reply text. Do not include meta-commentary or formatting.`;

// =============================================================================
// Action
// =============================================================================

export const replyRedditAction: Action = {
  name: "REPLY_REDDIT",
  similes: [
    "REDDIT_REPLY",
    "COMMENT_REDDIT",
    "REDDIT_COMMENT",
    "RESPOND_REDDIT",
  ],
  description:
    "Reply to Reddit posts and comments within daily limits. " +
    "Uses ElizaOS LLM to generate context-aware replies. " +
    "State is persisted to disk for resumption across restarts.",

  examples: [],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const clientId = runtime.getSetting("REDDIT_CLIENT_ID");
    const clientSecret = runtime.getSetting("REDDIT_CLIENT_SECRET");
    const username = runtime.getSetting("REDDIT_USERNAME");
    const password = runtime.getSetting("REDDIT_PASSWORD");

    if (!clientId || !clientSecret || !username || !password) {
      elizaLogger.warn(`[REDDIT-PLUGIN] REPLY_REDDIT validate failed: missing credentials`);
      return false;
    }
    return true;
  },

  handler: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<void> => {
    const startTime = Date.now();
    elizaLogger.info(`[REDDIT-PLUGIN] REPLY_REDDIT cycle started`);

    const config = createPluginConfig(runtime);
    const replyState = await loadReplyState(runtime);
    const today = new Date().toISOString().slice(0, 10);

    // Reset daily counter if day changed
    if (replyState.dailyDate !== today) {
      elizaLogger.info(
        `[REDDIT-PLUGIN] Daily reply reset: ${replyState.dailyDate} → ${today}`
      );
      replyState.dailyCount = 0;
      replyState.dailyDate = today;
    }

    // Check if daily limit is reached
    if (replyState.dailyCount >= config.maxRepliesPerDay) {
      elizaLogger.warn(
        `[REDDIT-PLUGIN] Daily reply limit reached (${replyState.dailyCount}/${config.maxRepliesPerDay})`
      );
      return;
    }

    const remainingBudget = config.maxRepliesPerDay - replyState.dailyCount;

    // Parse the message text for target fullnames to reply to
    // Expected format from discovery:
    // "Reply to these: t3_abc123 (post), t1_xyz789 (comment)"
    // Or a JSON array of { fullname, type, context? }
    const text = message.content?.text ?? "";

    // Extract reply targets — look for fullnames (t3_ for posts, t1_ for comments)
    const targetRegex = /(t[13]_[a-z0-9]+)/gi;
    const matches = text.match(targetRegex);

    if (!matches || matches.length === 0) {
      elizaLogger.info(`[REDDIT-PLUGIN] No reply targets found in message`);
      return;
    }

    // Filter out already-processed IDs
    const alreadyProcessed = new Set([
      ...replyState.repliedPostIds,
      ...replyState.processedCommentIds,
    ]);
    const toReply = matches.filter((id: string) => !alreadyProcessed.has(id));
    const batch = toReply.slice(0, remainingBudget);

    if (batch.length === 0) {
      elizaLogger.info(`[REDDIT-PLUGIN] All targets already processed`);
      return;
    }

    elizaLogger.info(
      `[REDDIT-PLUGIN] Preparing to reply to ${batch.length} targets (budget: ${remainingBudget})`
    );

    let successCount = 0;
    for (const fullname of batch) {
      try {
        // Determine if it's a post (t3_) or comment (t1_)
        const isPost = fullname.startsWith("t3_");
        const rawId = fullname.replace(/^t[13]_/, "");

        // Fetch context for the target
        let contextBody = "";
        let contextSubreddit = "";

        if (isPost) {
          // Fetch post details for context
          const details = await getPostDetails(config, rawId);
          if (details) {
            contextBody = details.post.selftext || details.post.title;
            contextSubreddit = details.post.subreddit;
          }
          else {
            elizaLogger.warn(`[REDDIT-PLUGIN] Could not fetch context for ${fullname} — generating reply without context`);
          }
        }

        // Generate reply using LLM
        const replyContent = await generateReply(runtime, {
          postContent: contextBody || "(context not available)",
          subreddit: contextSubreddit || "unknown",
        });

        if (!replyContent) {
          elizaLogger.warn(`[REDDIT-PLUGIN] LLM returned empty reply for ${fullname} — skipping`);
          continue;
        }

        // Post the reply
        const result = await reply(config, fullname, replyContent);

        if (result) {
          if (isPost) {
            replyState.repliedPostIds.push(fullname);
          } else {
            replyState.processedCommentIds.push(fullname);
          }
          replyState.dailyCount++;
          replyState.totalReplies++;
          successCount++;
        }

        // Polite delay between replies
        const delay = config.minDelayMs + Math.random() * (config.maxDelayMs - config.minDelayMs);
        await new Promise((r) => setTimeout(r, delay));
      } catch (err: any) {
        elizaLogger.error(`[REDDIT-PLUGIN] Failed to reply to ${fullname}: ${err.message}`);
      }
    }

    // Trim arrays to last 1000
    if (replyState.repliedPostIds.length > 1000) {
      replyState.repliedPostIds = replyState.repliedPostIds.slice(-1000);
    }
    if (replyState.processedCommentIds.length > 1000) {
      replyState.processedCommentIds = replyState.processedCommentIds.slice(-1000);
    }

    await saveReplyState(runtime, replyState);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    elizaLogger.info(
      `[REDDIT-PLUGIN] REPLY_REDDIT cycle completed in ${duration}s — ` +
      `${successCount}/${batch.length} replies posted ` +
      `(daily: ${replyState.dailyCount}/${config.maxRepliesPerDay}, total: ${replyState.totalReplies})`
    );
  },
};

// =============================================================================
// LLM reply generation
// =============================================================================

interface ReplyContext {
  postContent: string;
  subreddit: string;
}

async function generateReply(
  runtime: IAgentRuntime,
  context: ReplyContext
): Promise<string | null> {
  try {
    // Build a minimal state with the context
    const state: State = {
      agentId: runtime.agentId,
      bio: "",
      lore: "",
      knowledge: "",
      // These will be filled by composeContext
    } as State;

    // Compose the prompt from the template
    const prompt = composeContext({
      state: {
        ...state,
        agentName: runtime.character?.name ?? "Agent",
        postContent: context.postContent,
        subreddit: context.subreddit,
      },
      template: replyTemplate,
    });

    // Generate response via LLM
    const response = await generateMessageResponse({
      runtime,
      context: prompt,
      modelClass: ModelClass.SMALL,
    });

    const replyText = response?.text ?? null;

    if (!replyText || typeof replyText !== "string" || replyText.trim().length === 0) {
      elizaLogger.warn(`[REDDIT-PLUGIN] LLM generated empty reply`);
      return null;
    }

    const trimmed = replyText.trim();
    elizaLogger.info(
      `[REDDIT-PLUGIN] Generated reply (${trimmed.length} chars): "${trimmed.slice(0, 80)}..."`
    );

    return trimmed;
  } catch (err: any) {
    elizaLogger.error(`[REDDIT-PLUGIN] Reply generation failed: ${err.message}`);
    return null;
  }
}
