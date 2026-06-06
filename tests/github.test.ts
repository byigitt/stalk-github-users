import assert from "node:assert/strict";
import test from "node:test";

import { GitHubClient, GitHubRateLimitError } from "../src/github.js";
import type { FetchLike } from "../src/types.js";
import { pushEvent } from "./fixtures.js";

test("fetches and validates public user events", async () => {
  let requestedUrl = "";
  const fakeFetch: FetchLike = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify([pushEvent("push-1"), { invalid: true }]), { status: 200 });
  };

  const client = new GitHubClient({ fetch: fakeFetch, userAgent: "test-agent", baseUrl: "https://api.github.test" });
  const events = await client.fetchUserEvents("alice", 50);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.id, "push-1");
  assert.match(requestedUrl, /\/users\/alice\/events\/public\?per_page=50/);
});

test("surfaces GitHub rate limit reset evidence", async () => {
  const resetEpoch = Math.floor(Date.now() / 1000) + 60;
  const fakeFetch: FetchLike = async () => new Response(
    JSON.stringify({ message: "API rate limit exceeded" }),
    {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetEpoch),
      },
    },
  );

  const client = new GitHubClient({ fetch: fakeFetch, userAgent: "test-agent" });
  await assert.rejects(() => client.fetchUserEvents("alice", 50), GitHubRateLimitError);
});
