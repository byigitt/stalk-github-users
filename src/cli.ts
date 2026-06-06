#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { loadConfig, loadDotEnvFile, parseCliArgs, redactConfig } from "./config.js";
import { ConsoleNotifier, DiscordWebhookClient } from "./discord.js";
import { GitHubClient } from "./github.js";
import { GitHubStalker, formatSummary } from "./poller.js";
import { InMemoryStateStore, JsonStateStore, createFileLockRunner, runWithoutLock } from "./state.js";
import type { Logger } from "./types.js";
import { formatError } from "./utils.js";

const HELP = `GitHub user stalker

Usage:
  pnpm run once -- --dry-run
  pnpm start -- --config config.example.json
  node dist/src/cli.js [--config path] [--once] [--dry-run]

Options:
  --config <path>  Read JSON config file. Environment variables override file values.
  --once           Poll once and exit. Useful for cron, systemd timers, and smoke checks.
  --dry-run        Print Discord webhook payloads instead of sending them.
  --help           Show this help.

Environment:
  GITHUB_USERS             Comma/space/newline-separated usernames to watch.
  DISCORD_WEBHOOK_URL      Discord webhook URL. Required unless DRY_RUN=true.
  GITHUB_TOKEN             Optional token for higher GitHub API rate limits.
  POLL_INTERVAL_SECONDS    Default: 300.
  STATE_FILE               Default: .github-stalker-state.json.
  MAX_EVENTS_PER_USER      1-100, default: 50.
  NOTIFY_ON_STARTUP        Default: false.
  DRY_RUN                  true/false.
`;

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  logger: Logger = console,
): Promise<number> {
  try {
    const cliOptions = parseCliArgs(argv);
    if (cliOptions.help) {
      logger.info(HELP);
      return 0;
    }

    await loadDotEnvFile(undefined, env);
    const config = await loadConfig(cliOptions, env);
    logger.info(`Loaded config: ${JSON.stringify(redactConfig(config))}`);

    const github = new GitHubClient({
      ...(config.githubToken === undefined ? {} : { token: config.githubToken }),
      userAgent: config.userAgent,
    });
    const stateStore = config.dryRun ? new InMemoryStateStore() : new JsonStateStore(config.stateFile);
    const runExclusive = config.dryRun ? runWithoutLock : createFileLockRunner(`${config.stateFile}.lock`);
    const notifier = config.dryRun
      ? new ConsoleNotifier(logger)
      : new DiscordWebhookClient({ webhookUrl: requireWebhookUrl(config.discordWebhookUrl), logger });
    const stalker = new GitHubStalker(config, github, notifier, stateStore, logger, runExclusive);

    if (cliOptions.once) {
      const summary = await stalker.pollOnce();
      logger.info(formatSummary(summary));
      return summary.errors.length === 0 ? 0 : 1;
    }

    const abortController = new AbortController();
    process.once("SIGINT", () => abortController.abort());
    process.once("SIGTERM", () => abortController.abort());
    await stalker.runForever(abortController.signal);
    return 0;
  } catch (error) {
    logger.error(formatError(error));
    return 1;
  }
}

function requireWebhookUrl(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("Discord webhook URL is required unless dry-run is enabled.");
  }

  return value;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
