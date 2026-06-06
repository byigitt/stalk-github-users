import assert from "node:assert/strict";
import test from "node:test";

import { eventToNotification } from "../src/formatter.js";
import { createRepoEvent, issueEvent, pullRequestEvent, pushEvent } from "./fixtures.js";

test("formats push events with branch, commit count, commit URL, and compare URL", () => {
  const notification = eventToNotification(pushEvent("push-1"), "alice");

  assert.equal(notification?.kind, "push");
  assert.equal(notification?.repo, "alice/demo");
  assert.match(notification?.title ?? "", /pushed 1 commit/);
  assert.match(notification?.url ?? "", /github\.com\/alice\/demo\/compare\/1111111/);
  assert.match(JSON.stringify(notification?.fields), /Branch/);
  assert.match(JSON.stringify(notification?.fields), /2222222/);
  assert.match(JSON.stringify(notification?.fields), /Ship tracker/);
});

test("links first pushes to the head commit instead of an all-zero compare URL", () => {
  const event = pushEvent("first-push");
  event.payload.before = "0000000000000000000000000000000000000000";

  const notification = eventToNotification(event, "alice");

  assert.equal(
    notification?.url,
    "https://github.com/alice/demo/commit/2222222222222222222222222222222222222222",
  );
});

test("formats repository creation events", () => {
  const notification = eventToNotification(createRepoEvent("repo-1"), "alice");

  assert.equal(notification?.kind, "repository_created");
  assert.equal(notification?.url, "https://github.com/alice/new-repo");
  assert.match(notification?.description ?? "", /created the public repository/);
});

test("links tag creation events to the tag tree instead of a release page", () => {
  const event = createRepoEvent("tag-1");
  event.repo.name = "alice/demo";
  event.payload.ref_type = "tag";
  event.payload.ref = "v1.0.0";

  const notification = eventToNotification(event, "alice");

  assert.equal(notification?.kind, "tag_created");
  assert.equal(notification?.url, "https://github.com/alice/demo/tree/v1.0.0");
});

test("notifies only newly opened issues and pull requests", () => {
  assert.equal(eventToNotification(issueEvent("issue-opened"), "alice")?.kind, "issue_opened");
  assert.equal(eventToNotification(issueEvent("issue-closed", "closed"), "alice"), null);
  assert.equal(eventToNotification(pullRequestEvent("pr-opened"), "alice")?.kind, "pull_request_opened");
  assert.equal(eventToNotification(pullRequestEvent("pr-closed", "closed"), "alice"), null);
});
