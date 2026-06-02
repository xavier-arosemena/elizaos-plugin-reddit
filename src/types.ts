// =============================================================================
// Reddit Plugin — Type Definitions
// =============================================================================
// Tag: [REDDIT-PLUGIN]

/** A Reddit post (submission) */
export interface RedditPost {
  id: string;               // e.g. "t3_abc123"
  title: string;
  selftext: string;
  url: string;
  permalink: string;
  subreddit: string;
  subreddit_name_prefixed: string; // e.g. "r/europe"
  author: string;
  created_utc: number;
  score: number;
  upvote_ratio: number;
  num_comments: number;
  over_18: boolean;
  spoiler: boolean;
  stickied: boolean;
  is_self: boolean;         // true for text posts, false for link posts
  link_flair_text: string | null;
  link_flair_template_id: string | null;
  domain: string;
  thumbnail: string;
  preview?: any;
}

/** A Reddit comment */
export interface RedditComment {
  id: string;               // e.g. "t1_xyz789"
  body: string;
  permalink: string;
  link_id: string;          // parent post ID
  parent_id: string;        // parent comment ID (or post ID)
  subreddit: string;
  author: string;
  created_utc: number;
  score: number;
  depth: number;
  is_submitter: boolean;
  stickied: boolean;
  replies: RedditComment[];
}

/** A Reddit author/user (simplified) */
export interface RedditAuthor {
  name: string;
  id: string;
  created_utc: number;
  link_karma: number;
  comment_karma: number;
  is_gold: boolean;
  is_mod: boolean;
  has_verified_email: boolean;
  icon_img: string;
  subreddit: {
    title: string;
    subscribers: number;
  } | null;
}

/** Result from a Reddit search */
export interface RedditSearchResult {
  posts: RedditPost[];
  after: string | null;
  before: string | null;
  dist: number;
}

/** A scored opportunity — post matched by our discovery tiers, scored for relevance */
export interface ScoredOpportunity {
  post: RedditPost;
  score: number;           // 1-10, higher = more relevant
  source: string;          // "tier1" | "tier2" | "tier3"
  matchedKeyword?: string;
}

/** Plugin configuration parsed from env vars */
export interface PluginConfig {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  userAgent: string;
  // Limits
  maxUpvotesPerDay: number;
  maxUpvotesPerCycle: number;
  maxRepliesPerDay: number;
  maxSubscribesPerDay: number;
  // Discovery
  targetListPath: string;
  minPostScore: number;     // minimum score threshold for opportunities
  maxOpportunitiesPerCycle: number;
  // Anti-ban
  minDelayMs: number;
  maxDelayMs: number;
}

/** Search cycle state (disk-persisted) */
export interface SearchCycleState {
  lastCycleTime: number;
  cycleCount: number;
  keywordsCache: string[];
  keywordsCacheTime: number;
  processedPostIds: string[];
  lastTier2Time: number;
  lastTier3Time: number;
}

/** Upvote state (disk-persisted) */
export interface UpvoteState {
  dailyCount: number;
  dailyDate: string;
  totalUpvoted: number;
  upvotedPostIds: string[];
  rollingWindow: Array<{ postId: string; timestamp: number }>;
}

/** Reply state (disk-persisted) */
export interface ReplyState {
  dailyCount: number;
  dailyDate: string;
  totalReplies: number;
  repliedPostIds: string[];
  processedCommentIds: string[];
}

/** Subscribe state (disk-persisted) */
export interface SubscribeState {
  dailyCount: number;
  dailyDate: string;
  subscribedSubreddits: string[];
  unsubscribedSubreddits: string[];
}
