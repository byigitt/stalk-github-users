import { mkdir, open, readFile, stat, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { StalkerState, UserState } from "./types.js";
import { isRecord, readString, sleep } from "./utils.js";

export interface StateStore {
  load(): Promise<StalkerState>;
  save(state: StalkerState): Promise<void>;
}

export type ExclusiveRunner = <T>(operation: () => Promise<T>) => Promise<T>;

interface FileLockOptions {
  retryMs?: number;
  timeoutMs?: number;
  staleMs?: number;
}

export function createEmptyState(): StalkerState {
  return {
    version: 1,
    users: {},
  };
}

export function createFileLockRunner(lockFilePath: string, options: FileLockOptions = {}): ExclusiveRunner {
  const retryMs = options.retryMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const staleMs = options.staleMs ?? 30 * 60 * 1000;

  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const handle = await acquireFileLock(lockFilePath, retryMs, timeoutMs, staleMs);
    try {
      return await operation();
    } finally {
      await handle.close();
      await unlink(lockFilePath).catch(() => undefined);
    }
  };
}

export const runWithoutLock: ExclusiveRunner = async <T>(operation: () => Promise<T>): Promise<T> => operation();

export class InMemoryStateStore implements StateStore {
  private state = createEmptyState();

  async load(): Promise<StalkerState> {
    return structuredClone(this.state);
  }

  async save(state: StalkerState): Promise<void> {
    this.state = structuredClone(state);
  }
}

export class JsonStateStore implements StateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<StalkerState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return parseState(JSON.parse(raw));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return createEmptyState();
      }

      throw error;
    }
  }

  async save(state: StalkerState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.filePath);
  }
}

export function getUserState(state: StalkerState, username: string): UserState {
  const key = stateKey(username);
  const existing = state.users[key];
  if (existing !== undefined) {
    return existing;
  }

  const created: UserState = {
    seenEventIds: [],
  };
  state.users[key] = created;
  return created;
}

export function hasSeenEvent(state: StalkerState, username: string, eventId: string): boolean {
  return getUserState(state, username).seenEventIds.includes(eventId);
}

export function markEventSeen(
  state: StalkerState,
  username: string,
  eventId: string,
  maxSeenEvents: number,
): void {
  const userState = getUserState(state, username);
  userState.seenEventIds = [
    eventId,
    ...userState.seenEventIds.filter((seenEventId) => seenEventId !== eventId),
  ].slice(0, maxSeenEvents);
}

export function markEventsSeen(
  state: StalkerState,
  username: string,
  eventIds: readonly string[],
  maxSeenEvents: number,
): void {
  for (const eventId of eventIds) {
    markEventSeen(state, username, eventId, maxSeenEvents);
  }
}

export function stateKey(username: string): string {
  return username.toLowerCase();
}

function parseState(value: unknown): StalkerState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.users)) {
    throw new Error("State file is not a supported GitHub stalker state document.");
  }

  const state = createEmptyState();
  for (const [username, rawUserState] of Object.entries(value.users)) {
    if (!isRecord(rawUserState)) {
      continue;
    }

    const rawSeenEventIds = rawUserState.seenEventIds;
    const seenEventIds = Array.isArray(rawSeenEventIds)
      ? rawSeenEventIds.filter((eventId): eventId is string => typeof eventId === "string")
      : [];

    const userState: UserState = { seenEventIds };
    const initializedAt = readString(rawUserState, "initializedAt");
    const lastCheckedAt = readString(rawUserState, "lastCheckedAt");
    const lastEventAt = readString(rawUserState, "lastEventAt");

    if (initializedAt !== undefined) {
      userState.initializedAt = initializedAt;
    }
    if (lastCheckedAt !== undefined) {
      userState.lastCheckedAt = lastCheckedAt;
    }
    if (lastEventAt !== undefined) {
      userState.lastEventAt = lastEventAt;
    }

    state.users[stateKey(username)] = userState;
  }

  return state;
}

async function acquireFileLock(
  lockFilePath: string,
  retryMs: number,
  timeoutMs: number,
  staleMs: number,
): Promise<Awaited<ReturnType<typeof open>>> {
  await mkdir(dirname(lockFilePath), { recursive: true });
  const startedAt = Date.now();

  while (true) {
    try {
      const handle = await open(lockFilePath, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
        return handle;
      } catch (error) {
        await handle.close();
        await unlink(lockFilePath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }

      await removeStaleLock(lockFilePath, staleMs);
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for state lock: ${lockFilePath}`);
      }

      await sleep(retryMs);
    }
  }
}

async function removeStaleLock(lockFilePath: string, staleMs: number): Promise<void> {
  try {
    const lockStats = await stat(lockFilePath);
    if (Date.now() - lockStats.mtimeMs <= staleMs) {
      return;
    }

    const ownerPid = await readLockOwnerPid(lockFilePath);
    if (ownerPid !== undefined && isProcessAlive(ownerPid)) {
      return;
    }

    await unlink(lockFilePath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function readLockOwnerPid(lockFilePath: string): Promise<number | undefined> {
  try {
    const raw = await readFile(lockFilePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return parsed.pid;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
