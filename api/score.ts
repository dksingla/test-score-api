import axios from "axios";
import { normalizeUrl } from "../utils/crawler";
import { hybridCrawl } from "../utils/hybridCrawl";
import { fetchRobotsMeta } from "../utils/robots";
import { getClaudeScores } from "../utils/claude";
import { calculateScore } from "../utils/scoring";
import { collectLayer1Signals, fetchPageSpeed } from "../utils/layer1";
import { ratelimit } from "../utils/rateLimiter";

import type { ApiRequest, ApiResponse } from "../utils/types";
import type { ClaudeResponse } from "../utils/claude";
import type { Layer1Signals } from "../utils/layer1";

// Crawl + optional Olostep — bounded so Claude still fits in Vercel maxDuration (60s).
const CRAWL_PHASE_TIMEOUT_MS = 38_000;
const CLAUDE_TIMEOUT_MS = 20_000;

interface ErrorBody {
  success: false;
  error: string;
}

function sendError(res: ApiResponse, status: number, message: string): void {
  const body: ErrorBody = { success: false, error: message };
  res.status(status).json(body);
}

function isRateLimitConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL?.trim() &&
    process.env.UPSTASH_REDIS_REST_TOKEN?.trim(),
  );
}

function firstForwardedFor(headers: ApiRequest["headers"]): string | null {
  const v = headers?.["x-forwarded-for"];
  if (typeof v === "string") return v.split(",")[0]?.trim() || null;
  if (Array.isArray(v)) return v[0]?.split(",")[0]?.trim() || null;
  return null;
}

function getClientId(req: ApiRequest): string {
  return (
    firstForwardedFor(req.headers) ||
    req.ip ||
    req.socket?.remoteAddress ||
    "anonymous"
  );
}

export default async function handler(
  req: ApiRequest,
  res: ApiResponse,
): Promise<void> {
  if (req.method !== "POST") {
    return sendError(res, 405, "Method not allowed");
  }

  // Rate limiting (best-effort; skipped when Upstash env is missing)
  if (isRateLimitConfigured()) {
    try {
      const id = getClientId(req);
      const { success, limit, remaining, reset } = await ratelimit.limit(id);
      if (!success) {
        res.status(429).json({
          success: false,
          message: "Too many requests",
          limit,
          remaining,
          reset,
        });
        return;
      }
    } catch {
      // If rate limiting fails, continue rather than breaking scoring.
    }
  }

  const body = req.body as Record<string, unknown>;
  const rawUrl = body?.url;
  const name = body?.name as string | undefined;
  const email = body?.email as string | undefined;

  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return sendError(res, 400, "URL is required");
  }

  let url: string;
  try {
    url = normalizeUrl(rawUrl);
    new URL(url);
  } catch {
    return sendError(res, 400, "Invalid URL");
  }

  const crawlController = new AbortController();
  const crawlTimer = setTimeout(
    () => crawlController.abort(),
    CRAWL_PHASE_TIMEOUT_MS,
  );

  try {
    // Start PageSpeed immediately — does not depend on crawl output.
    const pageSpeedPromise = fetchPageSpeed(url).catch(() => ({
      pageSpeedScore: null,
      mobileFriendly: null,
    }));

    // ─────────────────────────────────────────────
    // STEP 1: Hybrid crawl (local + selective Olostep) + Robots
    // ─────────────────────────────────────────────
    const [crawlResult, robots] = await Promise.all([
      hybridCrawl(url, crawlController.signal),
      fetchRobotsMeta(url),
    ]);

    // Handle unreachable site (requirement)
    if (crawlResult.pages.length === 0) {
      res.status(200).json({
        score: 0,
        tier: "Hidden",
        business_name: "",
        business_description: "",
        confidence: "low",
        pillars: {},
        scores: {},
        error: "Unable to crawl site",
      });
      return;
    }

    // ─────────────────────────────────────────────
    // STEP 2: Claude AI + Layer 1 signals (parallel)
    // Layer 1 (sitemap + PageSpeed) typically completes in 2–5 s.
    // Claude typically takes 15–25 s. Starting both together means Layer 1
    // is already resolved before Claude finishes — zero extra latency.
    // ─────────────────────────────────────────────
    const layer1Promise = collectLayer1Signals(
      url,
      crawlResult.pages,
      robots,
      pageSpeedPromise,
    ).catch((): Layer1Signals | undefined => undefined);

    let aiScores: ClaudeResponse;
    try {
      aiScores = await Promise.race([
        getClaudeScores(crawlResult.pages),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Claude timeout")),
            CLAUDE_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (err) {
      console.error("Claude error:", err);
      return sendError(
        res,
        503,
        "AI analysis temporarily unavailable. Please try again.",
      );
    }

    // layer1 should already be resolved; await is effectively instant
    const layer1 = await layer1Promise;

    // ─────────────────────────────────────────────
    // STEP 3: Scoring Engine
    // ─────────────────────────────────────────────
    const final = calculateScore(
      aiScores,
      crawlResult.pages,
      robots,
      crawlResult.errors.length,
      layer1,
    );

    // ─────────────────────────────────────────────
    // STEP 4: Webhook (non-blocking)
    // ─────────────────────────────────────────────
    if (process.env.GHL_WEBHOOK_URL) {
      console.log("[score] sending webhook →", process.env.GHL_WEBHOOK_URL);
      axios
        .post(process.env.GHL_WEBHOOK_URL, {
          event: "scorecard_completed",
          contact: {
            name: name || "",
            email: email || "",
            website: url,
          },
          score: final.score,
          tier: final.tier,
          pillars: final.pillars,
          answers: final.answers,
          completedAt: new Date().toISOString(),
        })
        .catch((err) => {
          const status = err?.response?.status as number | undefined;
          console.error(
            "[score] webhook failed:",
            status ? `HTTP ${status}` : "",
            err?.message,
          );
        });
    } else {
      console.log("[score] webhook skipped (GHL_WEBHOOK_URL not set)");
    }

    // ─────────────────────────────────────────────
    // STEP 5: Response (FINAL OUTPUT FORMAT)
    // ─────────────────────────────────────────────
    res.status(200).json({
      score: final.score,
      tier: final.tier,
      // explanation: getScoreExplanation(final.score),
      business_name: final.businessName,
      business_description: final.businessDescription,
      confidence: final.confidence,
      pillars: final.pillars,
      scores: final.scores, // includes q2/q3 from Layer 1
    });
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return sendError(res, 500, message);
  } finally {
    clearTimeout(crawlTimer);
  }
}
