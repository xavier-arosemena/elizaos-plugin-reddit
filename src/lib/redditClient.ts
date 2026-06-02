// =============================================================================
// redditClient.ts — Reddit REST API wrappers (raw fetch, no SDK)
//
// OAuth2 password grant (script app): grant_type=password
// Token auto-refresh every 3600s (1 hour)
//
// Read operations: search, subreddit posts, user overview, inbox
// Write operations: submit post, reply, vote, subscribe
//
// Reddit API base (OAuth2): https://oauth.reddit.com
// Reddit auth endpoint:    https://www.reddit.com/api/v1/access_token
// Docs: https://www.reddit.com/dev/api/
//       https://github.com/reddit-archive/reddit/wiki/OAuth2
// =============================================================================

import { elizaLogger } from "@elizaos/core";
import type { PluginConfig, RedditPost, RedditComment, RedditAuthor, RedditSearchResult } from "../types.js";

const OAUTH_BASE = "https://oauth.reddit.com";
const AUTH_ENDPOINT = "https://www.reddit.com/api/v1/access_token";

// Token cache — module-level singleton, refreshed transparently
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

// Simple delay utility for rate-limit backoff
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Build the Basic auth header value for Reddit's access_token endpoint.
 * Reddit expects: client_id:client_secret base64-encoded.
 */
function basicAuthHeader(config: PluginConfig): string {
  return "Basic " + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
}

/**
 * Obtain (or refresh) an OAuth2 access token using the password grant flow.
 *
 * POST https://www.reddit.com/api/v1/access_token
 * Body: grant_type=password&username=USER&password=PASS
 * Auth: Basic (client_id:client_secret)
 *
 * Token lives 3600s (1 hour). We cache it and auto-refresh on expiry or 401.
 */
export async function getAccessToken(config: PluginConfig): Promise<string> {
  // Return cached token if still valid (with 5-minute buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 300_000) {
    return cachedToken;
  }

  const startTime = Date.now();

  try {
    const body = new URLSearchParams({
      grant_type: "password",
      username: config.username,
      password: config.password,
    });

    const res = await fetch(AUTH_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": basicAuthHeader(config),
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": config.userAgent,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    const duration = Date.now() - startTime;

    if (!res.ok) {
      const text = await res.text().catch(() => "unknown");
      elizaLogger.error(
        `[REDDIT-PLUGIN] Token request failed (HTTP ${res.status}) after ${duration}ms: ${text}`
      );
      throw new Error(`Reddit OAuth2 token error: HTTP ${res.status}`);
    }

    const data = await res.json() as { access_token: string; expires_in: number };
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;

    elizaLogger.info(
      `[REDDIT-PLUGIN] OAuth2 token obtained (expires in ${data.expires_in}s, took ${duration}ms)`
    );

    return cachedToken;
  } catch (err: any) {
    // Reset cache on failure so next call retries from scratch
    cachedToken = null;
    tokenExpiresAt = 0;
    elizaLogger.error(`[REDDIT-PLUGIN] Token acquisition failed: ${err.message}`);
    throw err;
  }
}

/**
 * Force token re-auth on next call (used after a 401 response).
 */
export function invalidateToken(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
  elizaLogger.warn(`[REDDIT-PLUGIN] Token invalidated — next call will re-authenticate`);
}

// =============================================================================
// Generic fetch helpers
// =============================================================================

/**
 * Core authenticated GET request to the Reddit OAuth2 API.
 * Automatically retries once on 401 (token stale) after re-authenticating.
 */
async function redditGet<T>(
  path: string,
  config: PluginConfig,
  searchParams?: Record<string, string | number | undefined>
): Promise<T | null> {
  const url = new URL(`${OAUTH_BASE}${path}`);
  if (searchParams) {
    for (const [key, val] of Object.entries(searchParams)) {
      if (val !== undefined && val !== null) {
        url.searchParams.set(key, String(val));
      }
    }
  }

  const attempt = async (): Promise<T | null> => {
    const token = await getAccessToken(config);
    const startTime = Date.now();

    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
          "User-Agent": config.userAgent,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });

      const duration = Date.now() - startTime;

      // 429 — rate limited: log and return null
      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After") || "60";
        elizaLogger.warn(
          `[REDDIT-PLUGIN] Rate limited (429) on GET ${path} — retry after ${retryAfter}s`
        );
        return null;
      }

      // 401 — token may have expired mid-use: refresh once
      if (res.status === 401) {
        elizaLogger.warn(`[REDDIT-PLUGIN] 401 on GET ${path} — re-authenticating and retrying`);
        invalidateToken();
        return null; // caller should retry
      }

      if (!res.ok) {
        elizaLogger.error(
          `[REDDIT-PLUGIN] GET ${path} failed (HTTP ${res.status}) after ${duration}ms`
        );
        return null;
      }

      return (await res.json()) as T;
    } catch (err: any) {
      elizaLogger.error(`[REDDIT-PLUGIN] GET ${path} network error: ${err.message}`);
      return null;
    }
  };

  // First attempt
  let result = await attempt();

  // If first attempt returned null due to 401, retry once with fresh token
  if (result === null && cachedToken === null) {
    elizaLogger.info(`[REDDIT-PLUGIN] Retrying GET ${path} with fresh token`);
    result = await attempt();
  }

  return result;
}

/**
 * Core authenticated POST request (JSON response expected).
 * Body is sent as application/x-www-form-urlencoded (Reddit standard for writes).
 */
async function redditPost<T>(
  path: string,
  config: PluginConfig,
  bodyParams: Record<string, string | number | boolean | undefined>
): Promise<T | null> {
  const attempt = async (): Promise<T | null> => {
    const token = await getAccessToken(config);
    const startTime = Date.now();

    const body = new URLSearchParams();
    for (const [key, val] of Object.entries(bodyParams)) {
      if (val !== undefined && val !== null) {
        body.set(key, String(val));
      }
    }

    try {
      const res = await fetch(`${OAUTH_BASE}${path}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "User-Agent": config.userAgent,
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(15_000),
      });

      const duration = Date.now() - startTime;

      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After") || "60";
        elizaLogger.warn(
          `[REDDIT-PLUGIN] Rate limited (429) on POST ${path} — retry after ${retryAfter}s`
        );
        return null;
      }

      if (res.status === 401) {
        elizaLogger.warn(`[REDDIT-PLUGIN] 401 on POST ${path} — re-authenticating and retrying`);
        invalidateToken();
        return null;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "unknown");
        elizaLogger.error(
          `[REDDIT-PLUGIN] POST ${path} failed (HTTP ${res.status}) after ${duration}ms: ${text}`
        );
        return null;
      }

      return (await res.json()) as T;
    } catch (err: any) {
      elizaLogger.error(`[REDDIT-PLUGIN] POST ${path} network error: ${err.message}`);
      return null;
    }
  };

  let result = await attempt();
  if (result === null && cachedToken === null) {
    elizaLogger.info(`[REDDIT-PLUGIN] Retrying POST ${path} with fresh token`);
    result = await attempt();
  }
  return result;
}

// =============================================================================
// Read API wrappers
// =============================================================================

/**
 * Search Reddit for posts matching `query`.
 *
 * GET /api/search?q=QUERY&limit=LIMIT&sort=SORT&t=TIMEFRAME&restrict_sr=RESTRICT
 *
 * Returns a RedditSearchResult or null on error.
 */
export async function searchReddit(
  config: PluginConfig,
  query: string,
  options?: {
    subreddit?: string;
    limit?: number;
    sort?: "relevance" | "hot" | "top" | "new" | "comments";
    time?: "hour" | "day" | "week" | "month" | "year" | "all";
    after?: string;
  }
): Promise<RedditSearchResult | null> {
  const params: Record<string, string | number | undefined> = {
    q: query,
    limit: options?.limit ?? 10,
    sort: options?.sort ?? "relevance",
    t: options?.time ?? "day",
    raw_json: 1,
    restrict_sr: options?.subreddit ? 1 : 0,
  };

  // If subreddit is specified, we search within that subreddit
  const path = options?.subreddit
    ? `/r/${options.subreddit}/search`
    : "/api/search";

  if (options?.after) {
    params.after = options.after;
  }

  const data = await redditGet<any>(path, config, params);
  if (!data?.data) return null;

  const children = data.data.children ?? [];
  const posts: RedditPost[] = children
    .filter((c: any) => c.kind === "t3")
    .map((c: any) => mapRedditPost(c.data));

  return {
    posts,
    after: data.data.after ?? null,
    before: data.data.before ?? null,
    dist: data.data.dist ?? posts.length,
  };
}

/**
 * Get posts from a specific subreddit.
 *
 * GET /r/{subreddit}/{listing}?limit=LIMIT&after=AFTER
 *
 * @param subreddit - Subreddit name (without r/)
 * @param listing   - "hot" | "new" | "top" | "rising" | "controversial"
 * @param options   - limit, time (for top/controversial), after cursor
 */
export async function getSubredditPosts(
  config: PluginConfig,
  subreddit: string,
  listing: "hot" | "new" | "top" | "rising" | "controversial" = "new",
  options?: {
    limit?: number;
    time?: "hour" | "day" | "week" | "month" | "year" | "all";
    after?: string;
  }
): Promise<RedditSearchResult | null> {
  const params: Record<string, string | number | undefined> = {
    limit: options?.limit ?? 25,
    raw_json: 1,
  };

  // "top" and "controversial" listings support a time filter
  if ((listing === "top" || listing === "controversial") && options?.time) {
    params.t = options.time;
  }

  if (options?.after) {
    params.after = options.after;
  }

  const data = await redditGet<any>(`/r/${subreddit}/${listing}`, config, params);
  if (!data?.data) return null;

  const children = data.data.children ?? [];
  const posts: RedditPost[] = children
    .filter((c: any) => c.kind === "t3")
    .map((c: any) => mapRedditPost(c.data));

  return {
    posts,
    after: data.data.after ?? null,
    before: data.data.before ?? null,
    dist: data.data.dist ?? posts.length,
  };
}

/**
 * Get full post details including comments.
 *
 * GET /api/info?id=t3_POST_ID&raw_json=1
 * Plus GET /r/{subreddit}/comments/{post_id} for threaded comments
 *
 * Returns { post, comments } or null on error.
 */
export async function getPostDetails(
  config: PluginConfig,
  postId: string,
  subreddit?: string
): Promise<{ post: RedditPost; comments: RedditComment[] } | null> {
  // We need the subreddit to fetch the comments listing page
  // First try: get the post info
  const infoData = await redditGet<any>("/api/info", config, {
    id: `t3_${postId.replace(/^t3_/, "")}`,
    raw_json: 1,
  });

  if (!infoData?.data?.children?.length) {
    // Fallback: try the comments endpoint with subreddit
    if (subreddit) {
      const commentData = await redditGet<any>(
        `/r/${subreddit}/comments/${postId.replace(/^t3_/, "")}`,
        config,
        { raw_json: 1, limit: 100 }
      );
      if (!commentData?.[0]?.data?.children?.length) return null;

      const post = mapRedditPost(commentData[0].data.children[0].data);
      const comments = extractComments(commentData[1]?.data?.children ?? []);
      return { post, comments };
    }
    return null;
  }

  const post = mapRedditPost(infoData.data.children[0].data);

  // If we have a subreddit, also fetch threaded comments
  let comments: RedditComment[] = [];
  if (subreddit || post.subreddit) {
    const sr = subreddit || post.subreddit;
    const commentData = await redditGet<any>(
      `/r/${sr}/comments/${postId.replace(/^t3_/, "")}`,
      config,
      { raw_json: 1, limit: 100 }
    );
    if (commentData?.[1]?.data?.children) {
      comments = extractComments(commentData[1].data.children);
    }
  }

  return { post, comments };
}

/**
 * Get overview of a user's public activity.
 *
 * GET /user/{username}/overview?limit=LIMIT&after=AFTER
 */
export async function getUserOverview(
  config: PluginConfig,
  username: string,
  options?: {
    limit?: number;
    after?: string;
    sort?: "hot" | "new" | "top" | "controversial";
  }
): Promise<{ posts: RedditPost[]; comments: RedditComment[] } | null> {
  const params: Record<string, string | number | undefined> = {
    limit: options?.limit ?? 25,
    raw_json: 1,
    sort: options?.sort ?? "new",
  };
  if (options?.after) params.after = options.after;

  const data = await redditGet<any>(`/user/${username}/overview`, config, params);
  if (!data?.data?.children) return null;

  const posts: RedditPost[] = [];
  const comments: RedditComment[] = [];

  for (const child of data.data.children) {
    if (child.kind === "t3") {
      posts.push(mapRedditPost(child.data));
    } else if (child.kind === "t1") {
      comments.push(mapRedditComment(child.data, child.data.subreddit));
    }
  }

  return { posts, comments };
}

/**
 * Get information about a subreddit.
 *
 * GET /r/{subreddit}/about
 */
export async function getSubredditAbout(
  config: PluginConfig,
  subreddit: string
): Promise<{
  title: string;
  subscribers: number;
  activeUserCount: number;
  description: string;
  publicDescription: string;
  over18: boolean;
  lang: string;
} | null> {
  const data = await redditGet<any>(`/r/${subreddit}/about`, config, {
    raw_json: 1,
  });
  if (!data?.data) return null;

  return {
    title: data.data.title,
    subscribers: data.data.subscribers ?? 0,
    activeUserCount: data.data.active_user_count ?? 0,
    description: data.data.description ?? "",
    publicDescription: data.data.public_description ?? "",
    over18: data.data.over18 ?? false,
    lang: data.data.lang ?? "en",
  };
}

/**
 * Get the authenticated user's inbox (mentions, comment replies, post replies, messages).
 *
 * GET /message/inbox?limit=LIMIT&after=AFTER
 * GET /message/unread?limit=LIMIT&after=AFTER
 *
 * @param folder - "inbox" (all) or "unread" (only unread)
 */
export async function getInbox(
  config: PluginConfig,
  folder: "inbox" | "unread" = "unread",
  options?: { limit?: number; after?: string }
): Promise<{
  messages: Array<{
    id: string;
    kind: "comment_reply" | "post_reply" | "message" | "username_mention";
    body: string;
    author: string;
    subreddit: string;
    createdUtc: number;
    wasComment: boolean;
    parentId: string;
    context: string; // permalink fragment
  }>;
  after: string | null;
} | null> {
  const params: Record<string, string | number | undefined> = {
    limit: options?.limit ?? 25,
    raw_json: 1,
  };
  if (options?.after) params.after = options.after;

  const data = await redditGet<any>(`/message/${folder}`, config, params);
  if (!data?.data?.children) return null;

  const messages = data.data.children.map((c: any) => {
    const d = c.data;
    return {
      id: d.id,
      kind: kindFromSubject(d.subject, d.was_comment),
      body: d.body ?? "",
      author: d.author ?? "[deleted]",
      subreddit: d.subreddit ?? "",
      createdUtc: d.created_utc ?? 0,
      wasComment: d.was_comment ?? false,
      parentId: d.parent_id ?? "",
      context: d.context ?? "",
    };
  });

  return {
    messages,
    after: data.data.after ?? null,
  };
}

/**
 * Get the authenticated user's own info.
 *
 * GET /api/v1/me
 */
export async function getMe(
  config: PluginConfig
): Promise<{
  name: string;
  id: string;
  createdUtc: number;
  linkKarma: number;
  commentKarma: number;
  isGold: boolean;
  isMod: boolean;
  hasVerifiedEmail: boolean;
  iconImg: string;
} | null> {
  const data = await redditGet<any>("/api/v1/me", config, { raw_json: 1 });
  if (!data) return null;

  return {
    name: data.name,
    id: data.id,
    createdUtc: data.created_utc ?? 0,
    linkKarma: data.link_karma ?? 0,
    commentKarma: data.comment_karma ?? 0,
    isGold: data.is_gold ?? false,
    isMod: data.is_mod ?? false,
    hasVerifiedEmail: data.has_verified_email ?? false,
    iconImg: data.icon_img ?? "",
  };
}

// =============================================================================
// Write API wrappers
// =============================================================================

/**
 * Submit a text (self) post to a subreddit.
 *
 * POST /api/submit
 * Body: kind=self, sr=SUBREDDIT, title=TITLE, text=TEXT
 *
 * Returns the fullname of the created post (e.g. "t3_abc123") or null on failure.
 */
export async function submitTextPost(
  config: PluginConfig,
  subreddit: string,
  title: string,
  text: string,
  options?: {
    flairId?: string;
    flairText?: string;
    nsfw?: boolean;
    spoiler?: boolean;
    sendReplies?: boolean;
  }
): Promise<string | null> {
  const result = await redditPost<any>("/api/submit", config, {
    kind: "self",
    sr: subreddit,
    title,
    text,
    resubmit: false,
    sendreplies: options?.sendReplies ?? true,
    flair_id: options?.flairId,
    flair_text: options?.flairText,
    nsfw: options?.nsfw ? true : undefined,
    spoiler: options?.spoiler ? true : undefined,
    raw_json: 1,
  });

  if (!result) {
    elizaLogger.error(`[REDDIT-PLUGIN] submitTextPost failed: null response`);
    return null;
  }

  // Reddit returns { json: { errors: [], data: { id, name, url } } }
  const json = result.json ?? result;
  if (json.errors?.length) {
    elizaLogger.error(
      `[REDDIT-PLUGIN] submitTextPost errors: ${JSON.stringify(json.errors)}`
    );
    return null;
  }

  const postFullname = json.data?.name ?? null;
  if (postFullname) {
    elizaLogger.info(
      `[REDDIT-PLUGIN] Submitted text post to r/${subreddit}: ${postFullname}`
    );
  }
  return postFullname;
}

/**
 * Submit a link post to a subreddit.
 *
 * POST /api/submit
 * Body: kind=link, sr=SUBREDDIT, title=TITLE, url=URL
 */
export async function submitLinkPost(
  config: PluginConfig,
  subreddit: string,
  title: string,
  url: string,
  options?: {
    flairId?: string;
    flairText?: string;
    nsfw?: boolean;
    spoiler?: boolean;
    sendReplies?: boolean;
  }
): Promise<string | null> {
  const result = await redditPost<any>("/api/submit", config, {
    kind: "link",
    sr: subreddit,
    title,
    url,
    resubmit: false,
    sendreplies: options?.sendReplies ?? true,
    flair_id: options?.flairId,
    flair_text: options?.flairText,
    nsfw: options?.nsfw ? true : undefined,
    spoiler: options?.spoiler ? true : undefined,
    raw_json: 1,
  });

  if (!result) return null;

  const json = result.json ?? result;
  if (json.errors?.length) {
    elizaLogger.error(
      `[REDDIT-PLUGIN] submitLinkPost errors: ${JSON.stringify(json.errors)}`
    );
    return null;
  }

  const postFullname = json.data?.name ?? null;
  if (postFullname) {
    elizaLogger.info(
      `[REDDIT-PLUGIN] Submitted link post to r/${subreddit}: ${postFullname}`
    );
  }
  return postFullname;
}

/**
 * Reply to a post or comment.
 *
 * POST /api/comment
 * Body: thing_id=FULLNAME, text=TEXT
 *
 * @param parentFullname - The fullname of the parent (e.g. "t3_abc123" or "t1_xyz789")
 * @param text           - The reply body (markdown)
 * @returns The fullname of the created comment (e.g. "t1_new123") or null
 */
export async function reply(
  config: PluginConfig,
  parentFullname: string,
  text: string
): Promise<string | null> {
  const result = await redditPost<any>("/api/comment", config, {
    thing_id: parentFullname,
    text,
    raw_json: 1,
  });

  if (!result) return null;

  const json = result.json ?? result;
  if (json.errors?.length) {
    elizaLogger.error(
      `[REDDIT-PLUGIN] reply errors: ${JSON.stringify(json.errors)}`
    );
    return null;
  }

  const commentFullname = json.data?.things?.[0]?.data?.name ?? null;
  if (commentFullname) {
    elizaLogger.info(
      `[REDDIT-PLUGIN] Replied to ${parentFullname}: ${commentFullname}`
    );
  }
  return commentFullname;
}

/**
 * Vote on a post or comment.
 *
 * POST /api/vote
 * Body: id=FULLNAME, dir=DIR
 *
 * @param fullname - Fullname of the thing (e.g. "t3_abc123")
 * @param dir      - 1 = upvote, 0 = unvote, -1 = downvote
 */
export async function vote(
  config: PluginConfig,
  fullname: string,
  dir: 1 | 0 | -1
): Promise<boolean> {
  const result = await redditPost<any>("/api/vote", config, {
    id: fullname,
    dir,
    raw_json: 1,
  });

  // Reddit vote returns an empty object on success
  const success = result !== null;
  if (success) {
    const dirLabel = dir === 1 ? "upvote" : dir === -1 ? "downvote" : "unvote";
    elizaLogger.info(`[REDDIT-PLUGIN] ${dirLabel} on ${fullname}`);
  } else {
    elizaLogger.error(`[REDDIT-PLUGIN] vote failed on ${fullname} (dir=${dir})`);
  }
  return success;
}

/**
 * Subscribe or unsubscribe to a subreddit.
 *
 * POST /api/subscribe
 * Body: action=sub|unsub, sr=SUBREDDIT_FULLNAME
 *
 * @param subredditFullname - The fullname of the subreddit (e.g. "t5_2qh0u" for r/europe)
 * @param action            - "sub" to subscribe, "unsub" to unsubscribe
 */
export async function subscribe(
  config: PluginConfig,
  subredditFullname: string,
  action: "sub" | "unsub"
): Promise<boolean> {
  const result = await redditPost<any>("/api/subscribe", config, {
    action,
    sr: subredditFullname,
    raw_json: 1,
  });

  const success = result !== null;
  if (success) {
    elizaLogger.info(
      `[REDDIT-PLUGIN] ${action === "sub" ? "Subscribed to" : "Unsubscribed from"} ${subredditFullname}`
    );
  } else {
    elizaLogger.error(
      `[REDDIT-PLUGIN] subscribe ${action} failed for ${subredditFullname}`
    );
  }
  return success;
}

/**
 * Mark inbox messages as read.
 *
 * POST /api/read_message
 * Body: id=FULLNAME (comma-separated for multiple)
 */
export async function markInboxRead(
  config: PluginConfig,
  messageFullnames: string | string[]
): Promise<boolean> {
  const ids = Array.isArray(messageFullnames) ? messageFullnames.join(",") : messageFullnames;
  const result = await redditPost<any>("/api/read_message", config, {
    id: ids,
    raw_json: 1,
  });

  const success = result !== null;
  if (success) {
    elizaLogger.info(`[REDDIT-PLUGIN] Marked ${ids} as read`);
  }
  return success;
}

/**
 * Save a post or comment.
 *
 * POST /api/save
 * Body: id=FULLNAME, category=CATEGORY (optional)
 */
export async function save(
  config: PluginConfig,
  fullname: string,
  category?: string
): Promise<boolean> {
  const result = await redditPost<any>("/api/save", config, {
    id: fullname,
    category: category ?? undefined,
    raw_json: 1,
  });
  return result !== null;
}

/**
 * Get a list of subreddits the authenticated user is subscribed to.
 *
 * GET /subreddits/mine/subscriber?limit=LIMIT&after=AFTER
 */
export async function getMySubreddits(
  config: PluginConfig,
  options?: { limit?: number; after?: string }
): Promise<{ subreddits: string[]; after: string | null } | null> {
  const params: Record<string, string | number | undefined> = {
    limit: options?.limit ?? 100,
    raw_json: 1,
  };
  if (options?.after) params.after = options.after;

  const data = await redditGet<any>("/subreddits/mine/subscriber", config, params);
  if (!data?.data?.children) return null;

  const subreddits = data.data.children.map((c: any) => c.data.display_name);
  return {
    subreddits,
    after: data.data.after ?? null,
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Map raw Reddit API submission data to our RedditPost interface.
 */
function mapRedditPost(d: any): RedditPost {
  return {
    id: d.name ?? `t3_${d.id}`, // prefer fullname "t3_xxx"; fallback to "t3_"+id
    title: d.title ?? "",
    selftext: d.selftext ?? "",
    url: d.url ?? "",
    permalink: d.permalink ?? "",
    subreddit: d.subreddit ?? "",
    subreddit_name_prefixed: d.subreddit_name_prefixed ?? `r/${d.subreddit}`,
    author: d.author ?? "[deleted]",
    created_utc: d.created_utc ?? 0,
    score: d.score ?? 0,
    upvote_ratio: d.upvote_ratio ?? 0,
    num_comments: d.num_comments ?? 0,
    over_18: d.over_18 ?? false,
    spoiler: d.spoiler ?? false,
    stickied: d.stickied ?? false,
    is_self: d.is_self ?? false,
    link_flair_text: d.link_flair_text ?? null,
    link_flair_template_id: d.link_flair_template_id ?? null,
    domain: d.domain ?? "",
    thumbnail: d.thumbnail ?? "",
    preview: d.preview ?? undefined,
  };
}

/**
 * Map raw Reddit API comment data to our RedditComment interface.
 */
function mapRedditComment(d: any, subreddit?: string): RedditComment {
  return {
    id: d.name ?? `t1_${d.id}`,
    body: d.body ?? "[removed]",
    permalink: d.permalink ?? "",
    link_id: d.link_id ?? "",
    parent_id: d.parent_id ?? "",
    subreddit: subreddit ?? d.subreddit ?? "",
    author: d.author ?? "[deleted]",
    created_utc: d.created_utc ?? 0,
    score: d.score ?? 0,
    depth: d.depth ?? 0,
    is_submitter: d.is_submitter ?? false,
    stickied: d.stickied ?? false,
    replies: [],
  };
}

/**
 * Recursively extract comments from Reddit's nested "replies" structure.
 */
function extractComments(children: any[], subreddit?: string): RedditComment[] {
  const result: RedditComment[] = [];

  for (const child of children) {
    if (child.kind !== "t1") continue;
    const d = child.data;

    const comment: RedditComment = {
      id: d.name ?? `t1_${d.id}`,
      body: d.body ?? "[removed]",
      permalink: d.permalink ?? "",
      link_id: d.link_id ?? "",
      parent_id: d.parent_id ?? "",
      subreddit: subreddit ?? d.subreddit ?? "",
      author: d.author ?? "[deleted]",
      created_utc: d.created_utc ?? 0,
      score: d.score ?? 0,
      depth: d.depth ?? 0,
      is_submitter: d.is_submitter ?? false,
      stickied: d.stickied ?? false,
      replies: [],
    };

    // Recursively process nested replies
    if (d.replies && typeof d.replies === "object" && d.replies.data?.children) {
      comment.replies = extractComments(d.replies.data.children, subreddit);
    }

    result.push(comment);
  }

  return result;
}

/**
 * Determine the inbox message kind from Reddit's response fields.
 */
function kindFromSubject(subject: string | undefined, wasComment: boolean | undefined): string {
  if (!subject) return "message";
  const s = subject.toLowerCase();
  if (s.includes("comment reply")) return "comment_reply";
  if (s.includes("post reply")) return "post_reply";
  if (s.includes("username mention")) return "username_mention";
  if (wasComment) return "comment_reply";
  return "message";
}
