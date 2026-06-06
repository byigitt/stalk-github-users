# Stalk GitHub Users

Watches the **public** activity of configured GitHub users and sends detailed notifications about new events to a Discord webhook. The following events are supported:

- `PushEvent`: new commit/push changes
- `CreateEvent`: new public repo, branch, or tag creation
- `IssuesEvent`: new issue opened
- `PullRequestEvent`: new PR opened

Notifications include the user, action type, repo, title/summary, GitHub URL, timestamp, branch, commit, issue, and PR details. Event IDs are kept in a persistent state file, so the same event is not sent again after a restart.

## Installation

```bash
pnpm install
cp .env.example .env
```

The CLI loads the `.env` file automatically on startup. Edit the values in `.env`:

```bash
GITHUB_USERS=octocat,torvalds
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
GITHUB_TOKEN= # optional, recommended for rate limits
POLL_INTERVAL_SECONDS=300
STATE_FILE=.github-stalker-state.json
NOTIFY_ON_STARTUP=false
```

Node.js `>=20.19.0` is required. Do not commit your real webhook URL. The `.env` and the default state file are in `.gitignore`.

## Running

One-off smoke check:

```bash
DRY_RUN=true GITHUB_USERS=octocat pnpm run once
```

Single poll with a real webhook:

```bash
pnpm run once
```

Continuous service:

```bash
pnpm start
```

The TypeScript build runs automatically before `pnpm run once` and `pnpm start`.

Running with a JSON config:

```bash
pnpm start -- --config config.example.json
```

Environment variables override JSON config values.

## First-run behavior

`NOTIFY_ON_STARTUP=false` is the default. In this mode the first poll writes the current activity returned by GitHub into the state but does not send it to Discord, so old activity does not spam. On subsequent polls only new event IDs are notified.

If you set `NOTIFY_ON_STARTUP=true`, the supported events that the GitHub public events API returns at that moment are also sent to Discord on the first poll.

## Rate limit and error behavior

- Only the GitHub public events API is read.
- `GITHUB_TOKEN` is optional but recommended to raise the rate limit.
- On GitHub rate limit errors the reset time is logged; events are not marked as seen.
- Discord `429` and `5xx` responses are retried.
- `DRY_RUN=true` prints the payloads for the currently supported events, behaves like `NOTIFY_ON_STARTUP=true`, and does not save event IDs to the persistent state file.
- An event ID is not written to state until the webhook succeeds, so failed deliveries are retried on the next poll.

## Verification

```bash
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run check
```

The tests cover:

- GitHub event formatting: push, repo creation, issue opened, PR opened
- Discord webhook payload format and mention suppression
- Discord 429 retry behavior
- Duplicate notification prevention and restart-safe state persistence
- First-poll bootstrap behavior
- Config parsing and the GitHub rate limit error surface

## Limitations

The GitHub public events API only returns public activity and a limited window of recent activity. For very active users, lower `POLL_INTERVAL_SECONDS` and raise `MAX_EVENTS_PER_USER` closer to 100.
