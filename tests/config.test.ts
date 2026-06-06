import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig, loadDotEnvFile, parseCliArgs, redactConfig } from "../src/config.js";

test("loads users from env and allows dry-run without webhook", async () => {
  const config = await loadConfig(
    { once: true, dryRun: true, help: false },
    {
      GITHUB_USERS: "alice, Bob\ncharlie",
      DRY_RUN: "true",
      POLL_INTERVAL_SECONDS: "60",
    },
  );

  assert.deepEqual(config.githubUsers, ["alice", "Bob", "charlie"]);
  assert.equal(config.dryRun, true);
  assert.equal(config.notifyOnStartup, true);
  assert.equal(config.discordWebhookUrl, undefined);
  assert.equal(config.pollIntervalMs, 60_000);
});

test("dry-run redaction tolerates placeholder webhook URLs", async () => {
  const config = await loadConfig(
    { once: true, dryRun: true, help: false },
    {
      GITHUB_USERS: "alice",
      DISCORD_WEBHOOK_URL: "placeholder-webhook",
    },
  );

  assert.equal(redactConfig(config).discordWebhookUrl, "[set: invalid-url]");
});

test("requires complete Discord webhook URL when not in dry-run", async () => {
  await assert.rejects(
    () => loadConfig(
      { once: true, help: false },
      {
        GITHUB_USERS: "alice",
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123",
      },
    ),
    /api\/webhooks\/\{id\}\/\{token\}/,
  );
});

test("requires valid GitHub usernames", async () => {
  await assert.rejects(
    () => loadConfig({ once: true, dryRun: true, help: false }, { GITHUB_USERS: "-bad-" }),
    /Invalid GitHub username/,
  );
});

test("blank env values do not override config file values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stalker-config-"));
  try {
    const configFile = join(dir, "config.json");
    await writeFile(
      configFile,
      JSON.stringify({
        githubUsers: ["alice"],
        discordWebhookUrl: "https://discord.com/api/webhooks/123/token",
        pollIntervalSeconds: 120,
      }),
      "utf8",
    );

    const config = await loadConfig(
      { configFile, once: true, help: false },
      {
        GITHUB_USERS: "",
        DISCORD_WEBHOOK_URL: "",
        POLL_INTERVAL_SECONDS: "",
      },
    );

    assert.deepEqual(config.githubUsers, ["alice"]);
    assert.equal(config.discordWebhookUrl, "https://discord.com/api/webhooks/123/token");
    assert.equal(config.pollIntervalMs, 120_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects invalid boolean config values instead of failing open", async () => {
  await assert.rejects(
    () => loadConfig(
      { once: true, help: false },
      {
        GITHUB_USERS: "alice",
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
        DRY_RUN: "treu",
      },
    ),
    /DRY_RUN must be true or false/,
  );

  await assert.rejects(
    () => loadConfig(
      { once: true, help: false },
      {
        GITHUB_USERS: "alice",
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/token",
        NOTIFY_ON_STARTUP: "maybe",
      },
    ),
    /NOTIFY_ON_STARTUP must be true or false/,
  );
});

test("rejects partial numeric config values", async () => {
  await assert.rejects(
    () => loadConfig({ once: true, dryRun: true, help: false }, { GITHUB_USERS: "alice", POLL_INTERVAL_SECONDS: "1abc" }),
    /poll interval seconds must be a positive integer/,
  );

  await assert.rejects(
    () => loadConfig({ once: true, dryRun: true, help: false }, { GITHUB_USERS: "alice", MAX_EVENTS_PER_USER: "1.5" }),
    /max events per user must be a positive integer/,
  );
});

test("loads .env files without overriding already exported values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stalker-env-"));
  try {
    const envFile = join(dir, ".env");
    await writeFile(
      envFile,
      [
        "GITHUB_USERS=alice,bob",
        "DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/123/token",
        "GITHUB_TOKEN= # inline comment means empty",
        "POLL_INTERVAL_SECONDS=120",
      ].join("\n"),
      "utf8",
    );

    const env: NodeJS.ProcessEnv = { POLL_INTERVAL_SECONDS: "60" };
    await loadDotEnvFile(envFile, env);

    assert.equal(env.GITHUB_USERS, "alice,bob");
    assert.equal(env.DISCORD_WEBHOOK_URL, "https://discord.com/api/webhooks/123/token");
    assert.equal(env.GITHUB_TOKEN, "");
    assert.equal(env.POLL_INTERVAL_SECONDS, "60");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parses CLI flags", () => {
  assert.deepEqual(parseCliArgs(["--config", "config.json", "--once", "--dry-run"]), {
    configFile: "config.json",
    once: true,
    dryRun: true,
    help: false,
  });
});
