# @elizaos/plugin-reddit

> ElizaOS plugin for Reddit integration — search, engage, and manage Reddit interactions autonomously.

[![GitHub](https://img.shields.io/badge/github-elizaos--plugin--reddit-blue)](https://github.com/xavier-arosemena/elizaos-plugin-reddit)

---

## Overview

This plugin enables ElizaOS agents to interact with Reddit through four composable actions:

| Action | Trigger | Purpose |
|--------|---------|---------|
| `SEARCH_REDDIT` | Cron / manual | 3-tier discovery (keyword search, subreddit feeds, inbox polling) |
| `UPVOTE_REDDIT` | Cron / manual | Upvote relevant posts within daily limits |
| `REPLY_REDDIT` | After search | Generate and post LLM-powered replies |
| `SUBSCRIBE_REDDIT` | Manual | Subscribe/unsubscribe to subreddits |

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    ElizaOS Agent Runtime                  │
│  ┌──────────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ searchReddit │  │ upvote   │  │ reply   subscribe  │  │
│  │ (3 tiers)    │  │ (limits) │  │ (LLM + limits)    │  │
│  └──────┬───────┘  └────┬─────┘  └────────┬──────────┘  │
│         │               │                  │             │
│         └───────────────┼──────────────────┘             │
│                         ▼                                │
│              ┌──────────────────┐                        │
│              │  redditClient.ts │                        │
│              │  (OAuth2 + REST) │                        │
│              └────────┬─────────┘                        │
│                       │                                  │
├───────────────────────┼──────────────────────────────────┤
│                       ▼                                  │
│            ┌──────────────────────┐                      │
│            │  Reddit OAuth2 API   │                      │
│            │  oauth.reddit.com    │                      │
│            └──────────────────────┘                      │
└──────────────────────────────────────────────────────────┘
```

---

## Installation

### 1. Clone the repository

```bash
git clone git@github.com:xavier-arosemena/elizaos-plugin-reddit.git
cd elizaos-plugin-reddit
npm install
```

### 2. Add to the ElizaOS workspace

Edit your `pnpm-workspace.yaml` to include the plugin:

```yaml
packages:
  - "plugins/*"
  - "elizaos-plugin-reddit"   # add this line
```

Add the dependency to your engine's `package.json`:

```json
"dependencies": {
  "@elizaos/plugin-reddit": "workspace:*"
}
```

### 3. Add the plugin to your character

In your character JSON's `"plugins"` array:

```json
"plugins": [
  "@elizaos/plugin-reddit"
]
```

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REDDIT_CLIENT_ID` | ✅ | — | OAuth2 client ID (from Reddit app) |
| `REDDIT_CLIENT_SECRET` | ✅ | — | OAuth2 client secret |
| `REDDIT_USERNAME` | ✅ | — | Bot account username |
| `REDDIT_PASSWORD` | ✅ | — | Bot account password |
| `REDDIT_USER_AGENT` | ❌ | `elizaos:plugin-reddit:v0.1.0` | Custom User-Agent string |
| `REDDIT_MAX_UPVOTES_PER_DAY` | ❌ | `20` | Daily upvote limit (anti-ban) |
| `REDDIT_MAX_UPVOTES_PER_CYCLE` | ❌ | `5` | Max upvotes per cron cycle |
| `REDDIT_MAX_REPLIES_PER_DAY` | ❌ | `10` | Daily reply limit |
| `REDDIT_MAX_SUBSCRIBES_PER_DAY` | ❌ | `5` | Daily subscribe limit |
| `REDDIT_TARGET_LIST_PATH` | ❌ | `./target_list.md` | Path to target list file |
| `REDDIT_MIN_POST_SCORE` | ❌ | `1` | Minimum post score to consider |
| `REDDIT_MAX_OPPORTUNITIES` | ❌ | `10` | Max opportunities per cycle |
| `REDDIT_MIN_DELAY_MS` | ❌ | `2000` | Min delay between API calls |
| `REDDIT_MAX_DELAY_MS` | ❌ | `8000` | Max delay between API calls |
| `REDDIT_SCOUT_ENABLED` | ❌ | `true` | Enable/disable Reddit scout cycle (controlled by intensity config) |
| `REDDIT_POST_ENABLED` | ❌ | `true` | Enable/disable Reddit posting cycle (controlled by intensity config) |
| `REDDIT_INBOX_ENABLED` | ❌ | `true` | Enable/disable Reddit inbox polling cycle (controlled by intensity config) |

### Getting Reddit API Credentials

> ⚠️ **Note:** The `https://www.reddit.com/prefs/apps` page is currently broken for new accounts (silent captcha error). If you cannot access it, file a support ticket at [reddithelp.com](https://reddithelp.com) using the option *"I'm a developer and want to build a Reddit App that does not work in the Devvit ecosystem."*

Once you have access:

1. Go to [https://www.reddit.com/prefs/apps](https://www.reddit.com/prefs/apps)
2. Click **create app** or **create another app**
3. Select **script** (not web app, not devvit)
4. Set redirect URI to `http://localhost:8080` (formality for script apps)
5. Note the **client_id** (under the app name) and **client_secret**

### User-Agent Best Practices

Reddit requires a descriptive User-Agent. The format should be:

```
<platform>:<app-name>:<version> (by /u/<reddit-username>)
```

Example:
```
elizaos:plugin-reddit:v0.1.0 (by /u/Least-Quiet-1305)
```

---

## Actions Reference

### `SEARCH_REDDIT` — 3-Tier Discovery

The core discovery action that finds opportunities across Reddit.

**Tier 1 — Keyword Search:** Searches Reddit using keywords from `target_list.md`. Posts are scored based on engagement, self-text quality, and upvote ratio.

**Tier 2 — Subreddit Feeds:** Monitors target subreddits for new posts. Lower confidence scoring (base 3), but catches trending content not matching keywords.

**Tier 3 — Inbox Polling:** Checks for unanswered mentions, comment replies, and direct messages. Always scores high (8/10) because someone is engaging with the bot.

**Delivery:** Results are formatted and sent to the primary agent via the `/:agentId/ingest` endpoint.

### `UPVOTE_REDDIT` — Limited Upvoting

Upvotes posts within configurable daily and per-cycle limits.
- Parses post fullnames (`t3_xxx`) from the message text
- Maintains a rolling window of upvote timestamps
- Resets daily counters automatically

### `REPLY_REDDIT` — LLM-Powered Replies

Generates context-aware replies using the ElizaOS LLM.
- Fetches post/comment context before replying
- Uses a structured prompt template (see [`replyTemplate`](src/actions/replyReddit.ts:67))
- Enforces 2-4 sentence replies
- Tracks processed IDs to avoid duplicates

### `SUBSCRIBE_REDDIT` — Subreddit Management

Subscribe or unsubscribe to subreddits.
- Input format: `+sub europe` (subscribe), `-unsub europe` (unsubscribe)
- Supports comma-separated, newline-separated, or semicolon-separated lists
- Deduplicates by (action + subreddit) key

---

## State Persistence

State files are stored in the `DATA_DIR` directory (default: `./data`).

| File | Action | Content |
|------|--------|---------|
| [`reddit_search_cycle_state.json`](src/actions/searchReddit.ts:30) | SEARCH_REDDIT | Cycle timing, processed post IDs, keyword cache |
| [`reddit_upvote_state.json`](src/actions/upvoteReddit.ts:14) | UPVOTE_REDDIT | Daily count, rolling window, already-upvoted IDs |
| [`reddit_reply_state.json`](src/actions/replyReddit.ts:17) | REPLY_REDDIT | Daily count, replied post/comment IDs |
| [`reddit_subscribe_state.json`](src/actions/subscribeReddit.ts:16) | SUBSCRIBE_REDDIT | Daily count, subscribed/unsubscribed subreddits |

---

## Target List Format

The optional [`target_list.md`](src/actions/searchReddit.ts:312) file defines which subreddits and topics to target.

```markdown
# Format: subreddit | topic | post_type | flair | rules | status
europe       | European Union, EU politics, Brexit | any  | ⬜ | Must cite sources | active
worldnews    | International news, geopolitics    | link |    | No opinion pieces  | active
technology   | AI, tech news, startups             | any  |    |                   | active
```

Only rows with `status = active` are used. Topics are split into keywords for Tier 1 search.

---

## Logging Convention

All log messages use a `[TAG]` prefix for easy filtering:

| Tag | Scope | Example |
|-----|-------|---------|
| `[REDDIT-PLUGIN]` | TypeScript code | `[REDDIT-PLUGIN] OAuth2 token obtained (expires in 3600s)` |
| `[REDDIT-SCRIPT]` | Shell scripts | `[REDDIT-SCRIPT] Post cycle complete (3/3 posted)` |

To filter logs:
```bash
grep '\[REDDIT-PLUGIN\]' logs/combined.log
journalctl -u elizaos-engine | grep '\[REDDIT-PLUGIN\]'
```

---

## Anti-Ban Features

Built-in protections to avoid Reddit's spam detection:

- **Daily rate limits:** Configurable per action (`REDDIT_MAX_UPVOTES_PER_DAY`, etc.)
- **Randomized delays:** Between 2-8 seconds (configurable) between API calls
- **Rolling window:** Tracks upvote timing to avoid burst patterns
- **Stickied post skip:** Never interacts with stickied (pinned) posts
- **Duplicate prevention:** Each action tracks processed IDs to avoid repeat actions
- **401 auto-refresh:** Transparent OAuth2 re-authentication if token expires mid-cycle
- **429 handling:** Logs rate limit warnings with Retry-After header

---

## Development

### Type Checking

```bash
npm run build
```

Note: `@elizaos/core` is a peer dependency — the project type-checks fully when linked in the ElizaOS workspace.

### Project Structure

```
elizaos-plugin-reddit/
├── src/
│   ├── actions/
│   │   ├── searchReddit.ts    # 3-tier discovery action
│   │   ├── upvoteReddit.ts    # Upvote action
│   │   ├── replyReddit.ts     # Reply with LLM generation
│   │   └── subscribeReddit.ts # Subscribe/unsubscribe
│   ├── lib/
│   │   └── redditClient.ts    # OAuth2 auth + REST API wrappers
│   ├── types.ts               # TypeScript interfaces
│   └── index.ts               # Plugin entry point
├── package.json
├── tsconfig.json
└── README.md
```

### Adding New Actions

1. Create a new file in `src/actions/`
2. Export an `Action` object following the ElizaOS `Action` interface
3. Import and register it in `src/index.ts`

---

## License

MIT
