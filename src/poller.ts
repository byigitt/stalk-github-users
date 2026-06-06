import { eventToNotification } from "./formatter.js";
import { GitHubRateLimitError } from "./github.js";
import {
  getUserState,
  hasSeenEvent,
  markEventSeen,
  markEventsSeen,
  runWithoutLock,
  type ExclusiveRunner,
  type StateStore,
} from "./state.js";
import type { AppConfig, GitHubEvent, Logger, PollSummary, StalkerState } from "./types.js";
import type { NotificationSink } from "./discord.js";
import { formatError, sleep } from "./utils.js";

export interface GitHubEventsSource {
  fetchUserEvents(username: string, perPage: number): Promise<GitHubEvent[]>;
}

export class GitHubStalker {
  constructor(
    private readonly config: AppConfig,
    private readonly github: GitHubEventsSource,
    private readonly notifier: NotificationSink,
    private readonly stateStore: StateStore,
    private readonly logger: Logger = console,
    private readonly runExclusive: ExclusiveRunner = runWithoutLock,
  ) {}

  async pollOnce(): Promise<PollSummary> {
    return this.runExclusive(() => this.pollOnceUnlocked());
  }

  private async pollOnceUnlocked(): Promise<PollSummary> {
    const state = await this.stateStore.load();
    const summary = emptySummary();

    for (const username of this.config.githubUsers) {
      summary.checkedUsers += 1;
      try {
        await this.pollUser(username, state, summary);
      } catch (error) {
        const message = describePollError(error);
        summary.errors.push({ username, message });
        this.logger.error(`Failed to poll ${username}: ${message}`);
      }
    }

    return summary;
  }

  async runForever(signal?: AbortSignal): Promise<void> {
    this.logger.info(
      `Watching ${this.config.githubUsers.join(", ")} every ${Math.round(this.config.pollIntervalMs / 1000)}s.`,
    );

    while (!signal?.aborted) {
      const summary = await this.pollOnce();
      this.logger.info(formatSummary(summary));

      try {
        await sleep(this.config.pollIntervalMs, signal);
      } catch (error) {
        if (signal?.aborted) {
          return;
        }
        throw error;
      }
    }
  }

  private async pollUser(username: string, state: StalkerState, summary: PollSummary): Promise<void> {
    const now = new Date().toISOString();
    const userState = getUserState(state, username);
    const events = await this.github.fetchUserEvents(username, this.config.maxEventsPerUser);
    const notifications = events
      .map((event) => eventToNotification(event, username))
      .filter((notification) => notification !== null);

    if (userState.initializedAt === undefined && !this.config.notifyOnStartup) {
      markEventsSeen(
        state,
        username,
        notifications.map((notification) => notification.id),
        this.config.maxEventsPerUser * 10,
      );
      userState.initializedAt = now;
      userState.lastCheckedAt = now;
      summary.bootstrappedEvents += notifications.length;
      await this.stateStore.save(state);
      return;
    }

    const pendingNotifications = notifications
      .filter((notification) => !hasSeenEvent(state, username, notification.id))
      .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));

    summary.skippedSeenEvents += notifications.length - pendingNotifications.length;

    for (const notification of pendingNotifications) {
      await this.notifier.send(notification);
      markEventSeen(state, username, notification.id, this.config.maxEventsPerUser * 10);
      userState.initializedAt = userState.initializedAt ?? now;
      userState.lastCheckedAt = now;
      userState.lastEventAt = notification.occurredAt;
      summary.sentNotifications += 1;
      await this.stateStore.save(state);
    }

    userState.initializedAt = userState.initializedAt ?? now;
    userState.lastCheckedAt = now;
    await this.stateStore.save(state);
  }
}

export function emptySummary(): PollSummary {
  return {
    checkedUsers: 0,
    sentNotifications: 0,
    bootstrappedEvents: 0,
    skippedSeenEvents: 0,
    errors: [],
  };
}

export function formatSummary(summary: PollSummary): string {
  const errorSuffix = summary.errors.length === 0 ? "" : `, errors=${summary.errors.length}`;
  return `Poll complete: checked=${summary.checkedUsers}, sent=${summary.sentNotifications}, bootstrapped=${summary.bootstrappedEvents}, skipped_seen=${summary.skippedSeenEvents}${errorSuffix}`;
}

function describePollError(error: unknown): string {
  if (error instanceof GitHubRateLimitError) {
    const resetSuffix = error.resetAt === undefined ? "" : ` Reset at ${error.resetAt.toISOString()}.`;
    return `${error.message}${resetSuffix}`;
  }

  return formatError(error);
}
