import type { AppConfig, GitHubEvent } from "../src/types.js";

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    githubUsers: ["alice"],
    discordWebhookUrl: undefined,
    githubToken: undefined,
    pollIntervalMs: 10,
    stateFile: "memory",
    maxEventsPerUser: 50,
    notifyOnStartup: false,
    dryRun: true,
    userAgent: "test-agent",
    ...overrides,
  };
}

export function pushEvent(id: string, createdAt = "2026-01-01T00:00:00Z"): GitHubEvent {
  return {
    id,
    type: "PushEvent",
    actor: { login: "alice" },
    repo: { name: "alice/demo" },
    public: true,
    created_at: createdAt,
    payload: {
      ref: "refs/heads/main",
      before: "1111111111111111111111111111111111111111",
      head: "2222222222222222222222222222222222222222",
      size: 1,
      distinct_size: 1,
      commits: [
        {
          sha: "2222222222222222222222222222222222222222",
          message: "Ship tracker\n\nDetailed body",
          author: { name: "Alice" },
        },
      ],
    },
  };
}

export function createRepoEvent(id: string): GitHubEvent {
  return {
    id,
    type: "CreateEvent",
    actor: { login: "alice" },
    repo: { name: "alice/new-repo" },
    public: true,
    created_at: "2026-01-01T00:01:00Z",
    payload: {
      ref_type: "repository",
    },
  };
}

export function issueEvent(id: string, action = "opened"): GitHubEvent {
  return {
    id,
    type: "IssuesEvent",
    actor: { login: "alice" },
    repo: { name: "alice/demo" },
    public: true,
    created_at: "2026-01-01T00:02:00Z",
    payload: {
      action,
      issue: {
        number: 7,
        title: "Bug in watcher",
        html_url: "https://github.com/alice/demo/issues/7",
      },
    },
  };
}

export function pullRequestEvent(id: string, action = "opened"): GitHubEvent {
  return {
    id,
    type: "PullRequestEvent",
    actor: { login: "alice" },
    repo: { name: "alice/demo" },
    public: true,
    created_at: "2026-01-01T00:03:00Z",
    payload: {
      action,
      pull_request: {
        number: 9,
        title: "Add Discord notifier",
        html_url: "https://github.com/alice/demo/pull/9",
        head: { ref: "feature/discord" },
        base: { ref: "main" },
      },
    },
  };
}
