import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AppConfig, CliOptions } from "./types.js";
import { isRecord } from "./utils.js";

const DEFAULT_POLL_INTERVAL_SECONDS = 300;
const DEFAULT_STATE_FILE = ".github-stalker-state.json";
const DEFAULT_MAX_EVENTS_PER_USER = 50;
const DEFAULT_USER_AGENT = "stalk-github-users/0.1";
const USERNAME_PATTERN = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z\d_]*$/i;

interface RawConfig {
  githubUsers?: unknown;
  users?: unknown;
  discordWebhookUrl?: unknown;
  githubToken?: unknown;
  pollIntervalSeconds?: unknown;
  stateFile?: unknown;
  maxEventsPerUser?: unknown;
  notifyOnStartup?: unknown;
  dryRun?: unknown;
  userAgent?: unknown;
}

export async function loadDotEnvFile(
  path = resolve(".env"),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const line of raw.split(/\r?\n/u)) {
    const parsed = parseDotEnvLine(line);
    if (parsed === null) {
      continue;
    }

    const [key, value] = parsed;
    if (env[key] === undefined) {
      env[key] = value;
    }
  }
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    once: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--once") {
      options.once = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--config") {
      const nextArg = argv[index + 1];
      if (nextArg === undefined) {
        throw new Error("--config requires a file path.");
      }
      options.configFile = nextArg;
      index += 1;
      continue;
    }

    if (arg?.startsWith("--config=")) {
      options.configFile = arg.slice("--config=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export async function loadConfig(
  cliOptions: CliOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AppConfig> {
  const fileConfig = cliOptions.configFile === undefined ? {} : await readConfigFile(cliOptions.configFile);
  const dryRun = coerceBoolean(cliOptions.dryRun, "--dry-run")
    ?? coerceBoolean(firstConfigValue(env.DRY_RUN, fileConfig.dryRun), "DRY_RUN")
    ?? false;

  const githubUsers = parseUsers(firstConfigValue(env.GITHUB_USERS, env.WATCH_USERS, fileConfig.githubUsers, fileConfig.users));
  if (githubUsers.length === 0) {
    throw new Error("Configure at least one GitHub username with GITHUB_USERS or config.githubUsers.");
  }

  const discordWebhookUrl = coerceOptionalString(firstConfigValue(env.DISCORD_WEBHOOK_URL, fileConfig.discordWebhookUrl));
  if (!dryRun) {
    if (discordWebhookUrl === undefined) {
      throw new Error("Configure DISCORD_WEBHOOK_URL or enable DRY_RUN=true for local smoke checks.");
    }
    validateDiscordWebhookUrl(discordWebhookUrl);
  }

  const pollIntervalSeconds = coercePositiveInteger(
    firstConfigValue(env.POLL_INTERVAL_SECONDS, fileConfig.pollIntervalSeconds),
    DEFAULT_POLL_INTERVAL_SECONDS,
    "poll interval seconds",
  );
  const maxEventsPerUser = coercePositiveInteger(
    firstConfigValue(env.MAX_EVENTS_PER_USER, fileConfig.maxEventsPerUser),
    DEFAULT_MAX_EVENTS_PER_USER,
    "max events per user",
  );

  if (maxEventsPerUser > 100) {
    throw new Error("MAX_EVENTS_PER_USER cannot exceed GitHub's public events API per_page limit of 100.");
  }

  const stateFile = coerceOptionalString(firstConfigValue(env.STATE_FILE, fileConfig.stateFile)) ?? DEFAULT_STATE_FILE;
  const userAgent = coerceOptionalString(firstConfigValue(env.GITHUB_USER_AGENT, fileConfig.userAgent)) ?? DEFAULT_USER_AGENT;

  return {
    githubUsers,
    discordWebhookUrl,
    githubToken: coerceOptionalString(firstConfigValue(env.GITHUB_TOKEN, fileConfig.githubToken)),
    pollIntervalMs: pollIntervalSeconds * 1000,
    stateFile: resolve(stateFile),
    maxEventsPerUser,
    notifyOnStartup: dryRun || (coerceBoolean(firstConfigValue(env.NOTIFY_ON_STARTUP, fileConfig.notifyOnStartup), "NOTIFY_ON_STARTUP") ?? false),
    dryRun,
    userAgent,
  };
}

export function redactConfig(config: AppConfig): Record<string, unknown> {
  return {
    githubUsers: config.githubUsers,
    discordWebhookUrl: config.discordWebhookUrl === undefined ? undefined : redactWebhookUrl(config.discordWebhookUrl),
    githubToken: config.githubToken === undefined ? undefined : "[set]",
    pollIntervalMs: config.pollIntervalMs,
    stateFile: config.stateFile,
    maxEventsPerUser: config.maxEventsPerUser,
    notifyOnStartup: config.notifyOnStartup,
    dryRun: config.dryRun,
    userAgent: config.userAgent,
  };
}

function parseUsers(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  const rawUsers = Array.isArray(value)
    ? value.map((entry) => String(entry))
    : String(value).split(/[\s,]+/u);

  const users: string[] = [];
  const seen = new Set<string>();

  for (const rawUser of rawUsers) {
    const username = rawUser.trim();
    if (username.length === 0) {
      continue;
    }

    if (!USERNAME_PATTERN.test(username)) {
      throw new Error(`Invalid GitHub username: ${username}`);
    }

    const key = username.toLowerCase();
    if (!seen.has(key)) {
      users.push(username);
      seen.add(key);
    }
  }

  return users;
}

async function readConfigFile(path: string): Promise<RawConfig> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("Config file must contain a JSON object.");
  }

  return parsed;
}

function validateDiscordWebhookUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DISCORD_WEBHOOK_URL must be a valid URL.");
  }

  const allowedHost = parsed.hostname === "discord.com" || parsed.hostname === "discordapp.com";
  const pathParts = parsed.pathname.split("/").filter((part) => part.length > 0);
  const validWebhookPath = pathParts.length === 4
    && pathParts[0] === "api"
    && pathParts[1] === "webhooks"
    && pathParts[2] !== undefined
    && pathParts[3] !== undefined;

  if (parsed.protocol !== "https:" || !allowedHost || !validWebhookPath) {
    throw new Error("DISCORD_WEBHOOK_URL must be an https://discord.com/api/webhooks/{id}/{token} URL.");
  }
}

function firstConfigValue(...values: unknown[]): unknown {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length === 0) {
      continue;
    }
    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return undefined;
}

function coerceOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function coerceBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    throw new Error(`${label} must be true or false.`);
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return undefined;
  }
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${label} must be true or false.`);
}

function coercePositiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = parseInteger(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
}

function parseInteger(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  const normalized = String(value).trim();
  if (!/^\d+$/u.test(normalized)) {
    return Number.NaN;
  }

  return Number(normalized);
}

function parseDotEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return null;
  }

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex === -1) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  if (!ENV_KEY_PATTERN.test(key)) {
    return null;
  }

  const rawValue = trimmed.slice(separatorIndex + 1).trim();
  return [key, unquoteDotEnvValue(rawValue)];
}

function unquoteDotEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\n/gu, "\n");
  }

  if (value.startsWith("#")) {
    return "";
  }

  return value.replace(/\s+#.*$/u, "").trim();
}

function redactWebhookUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "[set: invalid-url]";
  }

  const segments = parsed.pathname.split("/");
  const id = segments.at(-2) ?? "webhook";
  parsed.pathname = `/api/webhooks/${id}/[redacted]`;
  return parsed.toString();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
