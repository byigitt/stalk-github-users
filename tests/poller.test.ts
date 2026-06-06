import assert from "node:assert/strict";
import test from "node:test";

import type { NotificationSink } from "../src/discord.js";
import { GitHubStalker } from "../src/poller.js";
import { createEmptyState, type StateStore } from "../src/state.js";
import type { ActivityNotification, GitHubEvent, StalkerState } from "../src/types.js";
import { pushEvent, testConfig } from "./fixtures.js";

class MemoryStateStore implements StateStore {
  state: StalkerState = createEmptyState();
  saveCount = 0;

  async load(): Promise<StalkerState> {
    return structuredClone(this.state);
  }

  async save(state: StalkerState): Promise<void> {
    this.saveCount += 1;
    this.state = structuredClone(state);
  }
}

class ScriptedGitHubSource {
  private index = 0;

  constructor(private readonly batches: GitHubEvent[][]) {}

  async fetchUserEvents(): Promise<GitHubEvent[]> {
    const batch = this.batches[this.index] ?? [];
    this.index += 1;
    return batch;
  }
}

class CollectingNotifier implements NotificationSink {
  sent: ActivityNotification[] = [];

  async send(notification: ActivityNotification): Promise<void> {
    this.sent.push(notification);
  }
}

const silentLogger = { info() {}, warn() {}, error() {} };

test("bootstraps first run without notifications and sends only new events later", async () => {
  const oldEvent = pushEvent("old", "2026-01-01T00:00:00Z");
  const newEvent = pushEvent("new", "2026-01-01T00:10:00Z");
  const github = new ScriptedGitHubSource([[oldEvent], [newEvent, oldEvent], [newEvent, oldEvent]]);
  const notifier = new CollectingNotifier();
  const store = new MemoryStateStore();
  const stalker = new GitHubStalker(testConfig(), github, notifier, store, silentLogger);

  const first = await stalker.pollOnce();
  assert.equal(first.bootstrappedEvents, 1);
  assert.equal(notifier.sent.length, 0);

  const second = await stalker.pollOnce();
  assert.equal(second.sentNotifications, 1);
  assert.equal(notifier.sent[0]?.id, "new");

  const third = await stalker.pollOnce();
  assert.equal(third.sentNotifications, 0);
  assert.equal(third.skippedSeenEvents, 2);
  assert.equal(notifier.sent.length, 1);
});

test("notifyOnStartup sends currently returned events once in chronological order", async () => {
  const older = pushEvent("older", "2026-01-01T00:00:00Z");
  const newer = pushEvent("newer", "2026-01-01T00:10:00Z");
  const github = new ScriptedGitHubSource([[newer, older], [newer, older]]);
  const notifier = new CollectingNotifier();
  const store = new MemoryStateStore();
  const stalker = new GitHubStalker(
    testConfig({ notifyOnStartup: true }),
    github,
    notifier,
    store,
    silentLogger,
  );

  const first = await stalker.pollOnce();
  assert.equal(first.sentNotifications, 2);
  assert.deepEqual(notifier.sent.map((notification) => notification.id), ["older", "newer"]);

  const second = await stalker.pollOnce();
  assert.equal(second.sentNotifications, 0);
  assert.equal(notifier.sent.length, 2);
});
