import { Resend } from "resend";
import type { ScorecardWebhookPayload } from "./webhook";

export interface WebhookFailureEmailInput {
  payload: ScorecardWebhookPayload;
  attempts: number;
  status: number | null;
  error: string | null;
  responseBody: unknown;
  failedAt: string;
}

function stringifyResponseBody(value: unknown): string {
  if (value == null) {
    return "null";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function sendWebhookFailureEmail(
  input: WebhookFailureEmailInput,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.FALLBACK_EMAIL_FROM?.trim();
  const to = process.env.FALLBACK_EMAIL_TO?.trim();

  if (!apiKey || !from || !to) {
    console.warn("[webhook] email fallback skipped: missing email env vars", {
      hasApiKey: Boolean(apiKey),
      hasFrom: Boolean(from),
      hasTo: Boolean(to),
    });
    return;
  }

  const resend = new Resend(apiKey);
  const responseBody = stringifyResponseBody(input.responseBody);
  const payloadJson = JSON.stringify(input.payload, null, 2);

  const { data, error } = await resend.emails.send({
    from,
    to: [to],
    subject: `Webhook fallback: ${input.payload.contact.website}`,
    text: [
      "Webhook delivery failed after all retries.",
      "",
      `Failed at: ${input.failedAt}`,
      `Attempts: ${input.attempts}`,
      `Status: ${input.status ?? "null"}`,
      `Error: ${input.error ?? "null"}`,
      `Contact Name: ${input.payload.contact.name}`,
      `Contact Email: ${input.payload.contact.email}`,
      `Website: ${input.payload.contact.website}`,
      `Score: ${input.payload.score}`,
      `Tier: ${input.payload.tier}`,
      "",
      "Response Body:",
      responseBody,
      "",
      "Payload:",
      payloadJson,
    ].join("\n"),
  });

  if (error) {
    throw new Error(
      `Resend email send failed: ${error.message ?? "Unknown error"}`,
    );
  }

  console.log("[webhook] fallback email sent", {
    contact: input.payload.contact,
    emailId: data?.id ?? null,
    to,
  });
}
