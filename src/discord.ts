import type { ActivityNotification, FetchLike, Logger } from "./types.js";
import { sleep, truncate } from "./utils.js";

interface DiscordWebhookClientOptions {
  webhookUrl: string;
  fetch?: FetchLike;
  logger?: Logger;
  maxRetries?: number;
}

interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbed {
  title: string;
  url: string;
  description: string;
  timestamp: string;
  fields: DiscordField[];
  footer: {
    text: string;
  };
}

interface DiscordPayload {
  content: string;
  embeds: DiscordEmbed[];
  allowed_mentions: {
    parse: string[];
  };
}

export interface NotificationSink {
  send(notification: ActivityNotification): Promise<void>;
}

export class DiscordWebhookError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, responseBody: string) {
    super(`Discord webhook request failed with HTTP ${status}.`);
    this.name = "DiscordWebhookError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

export class DiscordWebhookClient implements NotificationSink {
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private readonly maxRetries: number;

  constructor(private readonly options: DiscordWebhookClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.logger = options.logger ?? console;
    this.maxRetries = options.maxRetries ?? 3;
  }

  async send(notification: ActivityNotification): Promise<void> {
    const payload = notificationToDiscordPayload(notification);

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const response = await this.fetchImpl(this.options.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        return;
      }

      const body = await safeReadBody(response);
      const shouldRetry = attempt < this.maxRetries && (response.status === 429 || response.status >= 500);
      if (!shouldRetry) {
        throw new DiscordWebhookError(response.status, body);
      }

      const delayMs = retryDelayMs(response, body, attempt);
      this.logger.warn(`Discord webhook returned HTTP ${response.status}; retrying in ${delayMs}ms.`);
      await sleep(delayMs);
    }
  }
}

export class ConsoleNotifier implements NotificationSink {
  constructor(private readonly logger: Logger = console) {}

  async send(notification: ActivityNotification): Promise<void> {
    this.logger.info(JSON.stringify(notificationToDiscordPayload(notification), null, 2));
  }
}

export function notificationToDiscordPayload(notification: ActivityNotification): DiscordPayload {
  const fields = notification.fields.slice(0, 25).map((field) => ({
    name: truncate(field.name, 256),
    value: truncate(field.value, 1024),
    ...(field.inline === undefined ? {} : { inline: field.inline }),
  }));

  return {
    content: truncate(`🕵️ GitHub activity from **${notification.username}**: **${notification.title}**\n${notification.url}`, 2000),
    embeds: [
      {
        title: truncate(notification.title, 256),
        url: notification.url,
        description: truncate(notification.description, 4096),
        timestamp: notification.occurredAt,
        fields,
        footer: {
          text: truncate(`GitHub ${notification.kind} • event ${notification.id}`, 2048),
        },
      },
    ],
    allowed_mentions: {
      parse: [],
    },
  };
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function retryDelayMs(response: Response, body: string, attempt: number): number {
  const retryAfterHeader = response.headers.get("retry-after");
  if (retryAfterHeader !== null) {
    const seconds = Number.parseFloat(retryAfterHeader);
    if (Number.isFinite(seconds)) {
      return Math.max(250, Math.ceil(seconds * 1000));
    }
  }

  if (response.status === 429) {
    const retryAfterFromBody = parseDiscordRetryAfter(body);
    if (retryAfterFromBody !== undefined) {
      return Math.max(250, Math.ceil(retryAfterFromBody * 1000));
    }
  }

  return 500 * 2 ** attempt;
}

function parseDiscordRetryAfter(body: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "retry_after" in parsed) {
      const retryAfter = Number((parsed as { retry_after: unknown }).retry_after);
      return Number.isFinite(retryAfter) ? retryAfter : undefined;
    }
  } catch {
    return undefined;
  }

  return undefined;
}
