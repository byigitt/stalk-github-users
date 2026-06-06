export interface AppConfig {
  githubUsers: string[];
  discordWebhookUrl: string | undefined;
  githubToken: string | undefined;
  pollIntervalMs: number;
  stateFile: string;
  maxEventsPerUser: number;
  notifyOnStartup: boolean;
  dryRun: boolean;
  userAgent: string;
}

export interface CliOptions {
  configFile?: string;
  once: boolean;
  dryRun?: boolean;
  help: boolean;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface GitHubEvent {
  id: string;
  type: string;
  actor: {
    login: string;
  };
  repo: {
    name: string;
    url?: string;
  };
  payload: Record<string, unknown>;
  public: boolean;
  created_at: string;
}

export type NotificationKind =
  | "push"
  | "repository_created"
  | "branch_created"
  | "tag_created"
  | "issue_opened"
  | "pull_request_opened";

export interface NotificationField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface ActivityNotification {
  id: string;
  username: string;
  kind: NotificationKind;
  title: string;
  description: string;
  url: string;
  occurredAt: string;
  repo: string;
  fields: NotificationField[];
  sourceEvent: GitHubEvent;
}

export interface UserState {
  seenEventIds: string[];
  initializedAt?: string;
  lastCheckedAt?: string;
  lastEventAt?: string;
}

export interface StalkerState {
  version: 1;
  users: Record<string, UserState>;
}

export interface PollError {
  username: string;
  message: string;
}

export interface PollSummary {
  checkedUsers: number;
  sentNotifications: number;
  bootstrappedEvents: number;
  skippedSeenEvents: number;
  errors: PollError[];
}
