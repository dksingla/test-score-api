import { normalizeUrl } from "../utils/crawler";
import { hybridCrawl } from "../utils/hybridCrawl";
import { fetchRobotsMeta } from "../utils/robots";
import { collectLayer1Signals, fetchPageSpeed } from "../utils/layer1";

import type { ApiRequest, ApiResponse } from "../utils/types";

interface ErrorBody {
  success: false;
  error: string;
}

function sendError(res: ApiResponse, status: number, message: string): void {
  const body: ErrorBody = { success: false, error: message };
  res.status(status).json(body);
}

export default async function handler(
  req: ApiRequest,
  res: ApiResponse,
): Promise<void> {
  if (req.method !== "POST") {
    return sendError(res, 405, "Method not allowed");
  }

  const body = req.body as Record<string, unknown>;
  const rawUrl = body?.url;

  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return sendError(res, 400, "URL is required");
  }

  let url: string;
  try {
    url = normalizeUrl(rawUrl);
    new URL(url); // validate
  } catch {
    return sendError(res, 400, "Invalid URL");
  }

  const controller = new AbortController();

  try {
    // Start PageSpeed immediately — does not depend on crawl output.
    const pageSpeedPromise = fetchPageSpeed(url).catch(() => ({
      pageSpeedScore: null,
      mobileFriendly: null,
      error: "PageSpeed request failed",
    }));

    // ─────────────────────────────────────────────
    // STEP 1: Crawl + Robots (parallel)
    // ─────────────────────────────────────────────
    const [crawlResult, robots] = await Promise.all([
      hybridCrawl(url, controller.signal),
      fetchRobotsMeta(url),
    ]);

    if (crawlResult.pages.length === 0) {
      res.status(200).json({
        success: false,
        error: "Unable to crawl site — no pages returned",
        crawl_errors: crawlResult.errors,
      });
      return;
    }

    // ─────────────────────────────────────────────
    // STEP 2: Layer 1 signal extraction
    // (sitemap + PageSpeed run inside here)
    // ─────────────────────────────────────────────
    const signals = await collectLayer1Signals(
      url,
      crawlResult.pages,
      robots,
      pageSpeedPromise,
    );

    // ─────────────────────────────────────────────
    // STEP 3: Response
    // ─────────────────────────────────────────────
    res.status(200).json({
      success: true,
      data: signals,
      crawl: {
        pagesCrawled: crawlResult.pages.length,
        pages: crawlResult.pages.map((page) => ({
          url: page.url,
          wordCount: page.wordCount,
          unorderedListCount: page.unorderedListCount,
          orderedListCount: page.orderedListCount,
          tableCount: page.tableCount,
          blockquoteCount: page.blockquoteCount,
        })),
      },
      crawl_errors:
        crawlResult.errors.length > 0 ? crawlResult.errors : undefined,
    });
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return sendError(res, 500, message);
  }
}
