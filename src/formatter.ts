import type { ActivityNotification, GitHubEvent, NotificationField, NotificationKind } from "./types.js";
import { isRecord, pluralize, readNumber, readRecord, readString, singleLine, truncate } from "./utils.js";

const MAX_COMMIT_LINES = 5;
const ZERO_SHA_PATTERN = /^0{40}$/u;

export function eventToNotification(event: GitHubEvent, watchedUsername: string): ActivityNotification | null {
  switch (event.type) {
    case "PushEvent":
      return pushNotification(event, watchedUsername);
    case "CreateEvent":
      return createNotification(event, watchedUsername);
    case "IssuesEvent":
      return issueNotification(event, watchedUsername);
    case "PullRequestEvent":
      return pullRequestNotification(event, watchedUsername);
    default:
      return null;
  }
}

function pushNotification(event: GitHubEvent, watchedUsername: string): ActivityNotification {
  const payload = event.payload;
  const repo = event.repo.name;
  const actor = event.actor.login || watchedUsername;
  const branch = branchName(readString(payload, "ref"));
  const before = readString(payload, "before");
  const head = readString(payload, "head");
  const commits = readCommitRecords(payload);
  const count = readNumber(payload, "distinct_size") ?? readNumber(payload, "size") ?? commits.length;
  const title = `${actor} pushed ${pluralize(count, "commit")} to ${repo}`;
  const description = branch === undefined
    ? `${actor} pushed public commits to ${repo}.`
    : `${actor} pushed public commits to ${repo} on branch ${branch}.`;
  const fields = baseFields(repo);

  if (branch !== undefined) {
    fields.push({ name: "Branch", value: branch, inline: true });
  }

  fields.push({ name: "Commit count", value: String(count), inline: true });

  if (head !== undefined) {
    fields.push({ name: "Head commit", value: markdownLink(shortSha(head), commitUrl(repo, head)), inline: true });
  }

  const commitSummary = summarizeCommits(repo, commits);
  if (commitSummary !== undefined) {
    fields.push({ name: "Recent commits", value: commitSummary });
  }

  return notification({
    event,
    watchedUsername,
    kind: "push",
    title,
    description,
    url: compareOrRepoUrl(repo, before, head),
    fields,
  });
}

function createNotification(event: GitHubEvent, watchedUsername: string): ActivityNotification | null {
  const payload = event.payload;
  const repo = event.repo.name;
  const actor = event.actor.login || watchedUsername;
  const refType = readString(payload, "ref_type");
  const ref = readString(payload, "ref");

  if (refType === "repository") {
    return notification({
      event,
      watchedUsername,
      kind: "repository_created",
      title: `${actor} created repository ${repo}`,
      description: `${actor} created the public repository ${repo}.`,
      url: repoUrl(repo),
      fields: baseFields(repo),
    });
  }

  if (refType === "branch" && ref !== undefined) {
    return notification({
      event,
      watchedUsername,
      kind: "branch_created",
      title: `${actor} created branch ${ref} in ${repo}`,
      description: `${actor} created a public branch in ${repo}.`,
      url: `${repoUrl(repo)}/tree/${encodeURIComponent(ref)}`,
      fields: [...baseFields(repo), { name: "Branch", value: ref, inline: true }],
    });
  }

  if (refType === "tag" && ref !== undefined) {
    return notification({
      event,
      watchedUsername,
      kind: "tag_created",
      title: `${actor} created tag ${ref} in ${repo}`,
      description: `${actor} created a public tag in ${repo}.`,
      url: `${repoUrl(repo)}/tree/${encodeURIComponent(ref)}`,
      fields: [...baseFields(repo), { name: "Tag", value: ref, inline: true }],
    });
  }

  return null;
}

function issueNotification(event: GitHubEvent, watchedUsername: string): ActivityNotification | null {
  const payload = event.payload;
  if (readString(payload, "action") !== "opened") {
    return null;
  }

  const issue = readRecord(payload, "issue");
  if (issue === undefined) {
    return null;
  }

  const repo = event.repo.name;
  const actor = event.actor.login || watchedUsername;
  const number = readNumber(issue, "number");
  const issueTitle = readString(issue, "title") ?? "Untitled issue";
  const htmlUrl = readString(issue, "html_url") ?? repoUrl(repo);
  const fields = baseFields(repo);

  if (number !== undefined) {
    fields.push({ name: "Issue", value: `#${number}`, inline: true });
  }
  fields.push({ name: "Title", value: truncate(issueTitle, 1024) });

  return notification({
    event,
    watchedUsername,
    kind: "issue_opened",
    title: `${actor} opened issue${number === undefined ? "" : ` #${number}`} in ${repo}`,
    description: truncate(issueTitle, 4096),
    url: htmlUrl,
    fields,
  });
}

function pullRequestNotification(event: GitHubEvent, watchedUsername: string): ActivityNotification | null {
  const payload = event.payload;
  if (readString(payload, "action") !== "opened") {
    return null;
  }

  const pullRequest = readRecord(payload, "pull_request");
  if (pullRequest === undefined) {
    return null;
  }

  const repo = event.repo.name;
  const actor = event.actor.login || watchedUsername;
  const number = readNumber(pullRequest, "number");
  const prTitle = readString(pullRequest, "title") ?? "Untitled pull request";
  const htmlUrl = readString(pullRequest, "html_url") ?? repoUrl(repo);
  const fields = baseFields(repo);

  if (number !== undefined) {
    fields.push({ name: "Pull request", value: `#${number}`, inline: true });
  }

  const head = readRecord(pullRequest, "head");
  const base = readRecord(pullRequest, "base");
  const headRef = head === undefined ? undefined : readString(head, "ref");
  const baseRef = base === undefined ? undefined : readString(base, "ref");
  if (headRef !== undefined || baseRef !== undefined) {
    fields.push({ name: "Branch", value: `${headRef ?? "unknown"} → ${baseRef ?? "unknown"}`, inline: true });
  }

  fields.push({ name: "Title", value: truncate(prTitle, 1024) });

  return notification({
    event,
    watchedUsername,
    kind: "pull_request_opened",
    title: `${actor} opened PR${number === undefined ? "" : ` #${number}`} in ${repo}`,
    description: truncate(prTitle, 4096),
    url: htmlUrl,
    fields,
  });
}

function notification(input: {
  event: GitHubEvent;
  watchedUsername: string;
  kind: NotificationKind;
  title: string;
  description: string;
  url: string;
  fields: NotificationField[];
}): ActivityNotification {
  return {
    id: input.event.id,
    username: input.event.actor.login || input.watchedUsername,
    kind: input.kind,
    title: input.title,
    description: input.description,
    url: input.url,
    occurredAt: input.event.created_at,
    repo: input.event.repo.name,
    fields: input.fields,
    sourceEvent: input.event,
  };
}

function baseFields(repo: string): NotificationField[] {
  return [{ name: "Repository", value: markdownLink(repo, repoUrl(repo)), inline: true }];
}

function readCommitRecords(payload: Record<string, unknown>): Record<string, unknown>[] {
  const rawCommits = payload.commits;
  if (!Array.isArray(rawCommits)) {
    return [];
  }

  return rawCommits.filter(isRecord);
}

function summarizeCommits(repo: string, commits: readonly Record<string, unknown>[]): string | undefined {
  if (commits.length === 0) {
    return undefined;
  }

  const lines = commits.slice(0, MAX_COMMIT_LINES).map((commit) => {
    const sha = readString(commit, "sha");
    const message = truncate(singleLine(readString(commit, "message") ?? "No commit message"), 140);
    const author = readRecord(commit, "author");
    const authorName = author === undefined ? undefined : readString(author, "name") ?? readString(author, "username");
    const prefix = sha === undefined ? "•" : `• ${markdownLink(shortSha(sha), commitUrl(repo, sha))}`;
    const suffix = authorName === undefined ? "" : ` — ${authorName}`;
    return `${prefix} ${message}${suffix}`;
  });

  if (commits.length > MAX_COMMIT_LINES) {
    lines.push(`…and ${commits.length - MAX_COMMIT_LINES} more commit(s).`);
  }

  return truncate(lines.join("\n"), 1024);
}

function branchName(ref: string | undefined): string | undefined {
  if (ref === undefined) {
    return undefined;
  }

  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function compareOrRepoUrl(repo: string, before: string | undefined, head: string | undefined): string {
  if (head !== undefined && ZERO_SHA_PATTERN.test(head)) {
    return repoUrl(repo);
  }

  if (head !== undefined && (before === undefined || ZERO_SHA_PATTERN.test(before))) {
    return commitUrl(repo, head);
  }

  if (before === undefined || head === undefined) {
    return repoUrl(repo);
  }

  return `${repoUrl(repo)}/compare/${before}...${head}`;
}

function repoUrl(repo: string): string {
  return `https://github.com/${repo}`;
}

function commitUrl(repo: string, sha: string): string {
  return `${repoUrl(repo)}/commit/${sha}`;
}

function markdownLink(label: string, url: string): string {
  return `[${label}](${url})`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
