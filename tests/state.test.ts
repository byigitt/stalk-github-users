import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InMemoryStateStore,
  JsonStateStore,
  createEmptyState,
  createFileLockRunner,
  getUserState,
  hasSeenEvent,
  markEventSeen,
} from "../src/state.js";

test("tracks seen events by normalized username and caps stored ids", () => {
  const state = createEmptyState();
  markEventSeen(state, "Alice", "1", 2);
  markEventSeen(state, "alice", "2", 2);
  markEventSeen(state, "ALICE", "3", 2);

  assert.equal(hasSeenEvent(state, "alice", "1"), false);
  assert.equal(hasSeenEvent(state, "alice", "2"), true);
  assert.equal(hasSeenEvent(state, "alice", "3"), true);
  assert.deepEqual(getUserState(state, "alice").seenEventIds, ["3", "2"]);
});

test("keeps dry-run memory state in process without a file", async () => {
  const store = new InMemoryStateStore();
  const state = createEmptyState();
  markEventSeen(state, "alice", "event-1", 10);

  await store.save(state);
  const loaded = await store.load();
  assert.equal(hasSeenEvent(loaded, "alice", "event-1"), true);
});

test("serializes concurrent file-lock runners", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stalker-lock-"));
  try {
    const lockFile = join(dir, "state.json.lock");
    const runner = createFileLockRunner(lockFile, { retryMs: 5, timeoutMs: 1_000 });
    let active = 0;
    let maxActive = 0;

    await Promise.all([
      runner(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(20);
        active -= 1;
      }),
      runner(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(20);
        active -= 1;
      }),
    ]);

    assert.equal(maxActive, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("does not reap stale-looking locks owned by a live process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stalker-live-lock-"));
  try {
    const lockFile = join(dir, "state.json.lock");
    await writeFile(lockFile, JSON.stringify({ pid: process.pid }), "utf8");
    const oldDate = new Date(Date.now() - 60_000);
    await utimes(lockFile, oldDate, oldDate);

    const runner = createFileLockRunner(lockFile, { retryMs: 5, timeoutMs: 30, staleMs: 1 });
    await assert.rejects(() => runner(async () => undefined), /Timed out waiting for state lock/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persists state atomically as JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stalker-state-"));
  try {
    const file = join(dir, "state.json");
    const store = new JsonStateStore(file);
    const state = createEmptyState();
    markEventSeen(state, "alice", "event-1", 10);

    await store.save(state);
    const loaded = await store.load();
    assert.equal(hasSeenEvent(loaded, "alice", "event-1"), true);
    assert.match(await readFile(file, "utf8"), /event-1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
