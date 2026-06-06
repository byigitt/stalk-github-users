import assert from "node:assert/strict";
import test from "node:test";

import { DiscordWebhookClient, notificationToDiscordPayload } from "../src/discord.js";
import { eventToNotification } from "../src/formatter.js";
import type { FetchLike } from "../src/types.js";
import { pushEvent } from "./fixtures.js";

test("builds detailed Discord payload without mentions or colored embed indicator", () => {
  const notification = eventToNotification(pushEvent("push-1"), "alice");
  assert.ok(notification);

  const payload = notificationToDiscordPayload(notification);

  const embed = payload.embeds[0];
  assert.ok(embed);

  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal("color" in embed, false);
  assert.match(payload.content, /alice/);
  assert.match(JSON.stringify(payload), /Recent commits/);
  assert.match(JSON.stringify(payload), /https:\/\/github\.com\/alice\/demo/);
});

test("retries Discord 429 responses and then succeeds", async () => {
  const notification = eventToNotification(pushEvent("push-1"), "alice");
  assert.ok(notification);

  let calls = 0;
  const fakeFetch: FetchLike = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ retry_after: 0.001 }), { status: 429 });
    }

    return new Response(null, { status: 204 });
  };

  const client = new DiscordWebhookClient({
    webhookUrl: "https://discord.com/api/webhooks/123/token",
    fetch: fakeFetch,
    maxRetries: 1,
    logger: { info() {}, warn() {}, error() {} },
  });

  await client.send(notification);
  assert.equal(calls, 2);
});
