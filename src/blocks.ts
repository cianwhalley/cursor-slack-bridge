/**
 * Helpers for outbound Alert/Card Block Kit payloads (notifications).
 * Available today for tick scripts; chat replies stay plain mrkdwn in v1.
 */

export type AlertLevel = "default" | "info" | "success" | "warning" | "error";

export function alertBlock(level: AlertLevel, text: string): Record<string, unknown> {
  return {
    type: "alert",
    alert: {
      level,
      text: {
        type: "mrkdwn",
        text,
      },
    },
  };
}

export function cardBlock(opts: {
  title: string;
  subtitle?: string;
  body: string;
}): Record<string, unknown> {
  const card: Record<string, unknown> = {
    title: { type: "plain_text", text: opts.title },
    body: { type: "mrkdwn", text: opts.body },
  };
  if (opts.subtitle) {
    card.subtitle = { type: "mrkdwn", text: opts.subtitle };
  }
  return { type: "card", card };
}

export function notificationBlocks(opts: {
  level: AlertLevel;
  title: string;
  body: string;
}): Record<string, unknown>[] {
  return [alertBlock(opts.level, `*${opts.title}*\n${opts.body}`)];
}
