import type { FetchLike, GitHubEvent } from "./types.js";
import { isRecord, readString } from "./utils.js";

interface GitHubClientOptions {
  token?: string;
  userAgent: string;
  fetch?: FetchLike;
  baseUrl?: string;
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, message: string, responseBody: string) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

export class GitHubRateLimitError extends GitHubApiError {
  readonly resetAt: Date | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, message: string, responseBody: string, resetAt: Date | undefined, retryAfterSeconds: number | undefined) {
    super(status, message, responseBody);
    this.name = "GitHubRateLimitError";
    this.resetAt = resetAt;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class GitHubClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly userAgent: string;

  constructor(options: GitHubClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.github.com";
    this.token = options.token;
    this.userAgent = options.userAgent;
  }

  async fetchUserEvents(username: string, perPage: number): Promise<GitHubEvent[]> {
    const url = new URL(`/users/${encodeURIComponent(username)}/events/public`, this.baseUrl);
    url.searchParams.set("per_page", String(perPage));

    const response = await this.fetchImpl(url, {
      headers: this.headers(),
    });

    if (!response.ok) {
      throw await buildGitHubError(response, username);
    }

    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      throw new GitHubApiError(response.status, `GitHub returned an unexpected events payload for ${username}.`, JSON.stringify(payload));
    }

    return payload.filter(isGitHubEvent);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": this.userAgent,
    };

    if (this.token !== undefined) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    return headers;
  }
}

function isGitHubEvent(value: unknown): value is GitHubEvent {
  if (!isRecord(value) || !isRecord(value.actor) || !isRecord(value.repo) || !isRecord(value.payload)) {
    return false;
  }

  return typeof value.id === "string"
    && typeof value.type === "string"
    && typeof value.actor.login === "string"
    && typeof value.repo.name === "string"
    && typeof value.created_at === "string"
    && typeof value.public === "boolean";
}

async function buildGitHubError(response: Response, username: string): Promise<GitHubApiError> {
  const body = await safeReadBody(response);
  const baseMessage = `GitHub API request for ${username} failed with HTTP ${response.status}.`;
  const remaining = response.headers.get("x-ratelimit-remaining");
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  const resetAt = parseRateLimitReset(response.headers.get("x-ratelimit-reset"));

  if (response.status === 403 || response.status === 429 || remaining === "0") {
    const resetMessage = resetAt === undefined ? "" : ` Rate limit resets at ${resetAt.toISOString()}.`;
    return new GitHubRateLimitError(response.status, `${baseMessage}${resetMessage}`, body, resetAt, retryAfter);
  }

  const apiMessage = parseApiMessage(body);
  return new GitHubApiError(response.status, apiMessage === undefined ? baseMessage : `${baseMessage} ${apiMessage}`, body);
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function parseApiMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      return readString(parsed, "message");
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function parseRateLimitReset(value: string | null): Date | undefined {
  if (value === null) {
    return undefined;
  }

  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds)) {
    return undefined;
  }

  return new Date(seconds * 1000);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const seconds = Number.parseFloat(value);
  return Number.isFinite(seconds) ? seconds : undefined;
}
