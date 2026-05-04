import axios from "axios";
import type { PriorityFix } from "./claude";

const WEBHOOK_TIMEOUT_MS = 10_000;
const WEBHOOK_ATTEMPTS = 3;
const WEBHOOK_RETRY_DELAY_MS = 2_000;

export interface ScorecardWebhookPayload {
  event: "scorecard_completed";
  contact: {
    name: string;
    email: string;
    website: string;
  };
  score: number;
  tier: string;
  pillars: {
    foundation: number;
    intent: number;
    relevance: number;
    expertise: number;
    unify: number;
    performance: number;
  };
  answers: Record<string, number>;
  priority_fixes: PriorityFix[];
  ghl_flat: Record<string, string | null>;
  completedAt: string;
}

export interface WebhookDeliveryResult {
  delivered: boolean;
  attempts: number;
  status: number | null;
  error: string | null;
  responseBody: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildGhlFlat(
  priorityFixes: PriorityFix[],
): Record<string, string | null> {
  const ghlFlat: Record<string, string | null> = {};

  for (let rank = 1; rank <= 5; rank += 1) {
    const fix = priorityFixes.find((item) => item.rank === rank) ?? null;

    ghlFlat[`priority_fix_${rank}_ref`] = fix?.question_ref ?? null;
    ghlFlat[`priority_fix_${rank}_pillar`] = fix?.pillar ?? null;
    ghlFlat[`priority_fix_${rank}_issue`] = fix?.issue ?? null;
    ghlFlat[`priority_fix_${rank}_action`] = fix?.fix ?? null;
  }

  return ghlFlat;
}

export function buildScorecardWebhookPayload(input: {
  name: string;
  email: string;
  website: string;
  score: number;
  tier: string;
  pillars: ScorecardWebhookPayload["pillars"];
  answers: Record<string, number>;
  priorityFixes: PriorityFix[];
  completedAt?: string;
}): ScorecardWebhookPayload {
  const priorityFixes = input.priorityFixes
    .slice(0, 5)
    .map((fix, index) => ({
      rank: index + 1,
      question_ref: fix.question_ref,
      pillar: fix.pillar,
      issue: fix.issue,
      fix: fix.fix,
    }));

  return {
    event: "scorecard_completed",
    contact: {
      name: input.name,
      email: input.email,
      website: input.website,
    },
    score: input.score,
    tier: input.tier,
    pillars: input.pillars,
    answers: input.answers,
    priority_fixes: priorityFixes,
    ghl_flat: buildGhlFlat(priorityFixes),
    completedAt: input.completedAt ?? new Date().toISOString(),
  };
}

export async function sendScorecardWebhook(
  payload: ScorecardWebhookPayload,
): Promise<WebhookDeliveryResult> {
  const webhookUrl = process.env.GHL_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    return {
      delivered: false,
      attempts: 0,
      status: null,
      error: "GHL_WEBHOOK_URL not set",
      responseBody: null,
    };
  }

  let lastStatus: number | null = null;
  let lastError: string | null = null;
  let lastResponseBody: unknown = null;

  for (let attempt = 1; attempt <= WEBHOOK_ATTEMPTS; attempt += 1) {
    try {
      const response = await axios.post(webhookUrl, payload, {
        timeout: WEBHOOK_TIMEOUT_MS,
        validateStatus: () => true,
      });

      if (response.status >= 200 && response.status < 300) {
        return {
          delivered: true,
          attempts: attempt,
          status: response.status,
          error: null,
          responseBody: response.data ?? null,
        };
      }

      lastStatus = response.status;
      lastResponseBody = response.data ?? null;
      lastError = `Webhook returned HTTP ${response.status}`;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        lastStatus = error.response?.status ?? null;
        lastResponseBody = error.response?.data ?? null;
        lastError = error.message;
      } else {
        lastStatus = null;
        lastResponseBody = null;
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    if (attempt < WEBHOOK_ATTEMPTS) {
      await sleep(WEBHOOK_RETRY_DELAY_MS);
    }
  }

  console.error("[webhook] delivery failed after 3 attempts", {
    contact: payload.contact,
    payload,
    status: lastStatus,
    error: lastError,
    responseBody: lastResponseBody,
    failedAt: new Date().toISOString(),
  });

  return {
    delivered: false,
    attempts: WEBHOOK_ATTEMPTS,
    status: lastStatus,
    error: lastError,
    responseBody: lastResponseBody,
  };
}
