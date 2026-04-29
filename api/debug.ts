import { normalizeUrl } from "../utils/crawler";
import { hybridCrawl } from "../utils/hybridCrawl";
import { fetchRobotsMeta } from "../utils/robots";
import { collectLayer1Signals, fetchPageSpeed } from "../utils/layer1";
import { buildDebugPayload } from "../utils/claude";

import type { ApiRequest, ApiResponse } from "../utils/types";

function sendError(res: ApiResponse, status: number, message: string): void {
  res.status(status).json({ success: false, error: message });
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
    new URL(url);
  } catch {
    return sendError(res, 400, "Invalid URL");
  }

  const controller = new AbortController();

  try {
    // Debug endpoint should not slice HTML. Enable unlimited fetch mode for this request.
    // Note: This is process-wide, but /api/debug is intended for local debugging only.
    process.env.CRAWLER_DEBUG_NO_LIMIT = "1";

    // Start PageSpeed immediately — does not depend on crawl output.
    const pageSpeedPromise = fetchPageSpeed(url).catch(() => ({
      pageSpeedScore: null,
      mobileFriendly: null,
      error: "PageSpeed request failed",
    }));

    // ── STEP 1: Crawl + Robots in parallel ────────────────────────────────────
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

    // ── STEP 2: Layer 1 signals + Claude payload (parallel) ───────────────────
    const [layer1, debugPayload] = await Promise.all([
      collectLayer1Signals(
        url,
        crawlResult.pages,
        robots,
        pageSpeedPromise,
      ).catch(() => null),
      Promise.resolve(buildDebugPayload(crawlResult.pages)),
    ]);

    // ── STEP 3: Return everything ──────────────────────────────────────────────
    res.status(200).json({
      success: true,

      // ── Crawl summary ──────────────────────────────────────────────────────
      crawl: {
        pagesCrawled: crawlResult.pages.length,
        errors: crawlResult.errors,
        robots,
      },

      // ── Full raw page data from parser (one entry per crawled URL) ─────────
      rawPages: crawlResult.pages.map((p) => ({
        url: p.url,
        title: p.title,
        metaDescription: p.metaDescription,
        h1Tags: p.h1Tags,
        h2Tags: p.h2Tags,
        bodyText: p.bodyText,
        bodyTextLength: p.bodyText.length,
        schemas: p.schemas,
        outboundLinks: p.outboundLinks,
        isJSSite: p.isJSSite,
        ga4Id: p.ga4Id,
        gtmId: p.gtmId,
        hasForm: p.hasForm,
        ctaTexts: p.ctaTexts,
        wordCount: p.wordCount,
        unorderedListCount: p.unorderedListCount,
        orderedListCount: p.orderedListCount,
        tableCount: p.tableCount,
        blockquoteCount: p.blockquoteCount,
        socialProfiles: p.socialProfiles,
        schemaSignals: p.schemaSignals,
        dateModified: p.dateModified,
      })),

      // ── Layer 1 technical signals ──────────────────────────────────────────
      layer1Signals: layer1,

      // ── Claude AI input — page selection ──────────────────────────────────
      // Shows exactly which pages were picked for each intent bucket
      aiPageSelection: {
        isThinSite: debugPayload.isThinSite,
        homepageUrl: debugPayload.selectedPages.homepage?.url ?? null,
        aboutUrl: debugPayload.selectedPages.about?.url ?? null,
        servicesUrl: debugPayload.selectedPages.services?.url ?? null,
        blogUrls: debugPayload.selectedPages.blog.map((p) => p.url),
        proofUrls: debugPayload.selectedPages.proof.map((p) => p.url),
      },

      // ── Claude AI input — trimmed payload sent to prompt ──────────────────
      // The actual compressed data Claude receives (after trimPage + buildSiteSummary)
      aiTrimmedPayload: debugPayload.trimmedPayload,

      // ── Claude AI input — full prompt string ──────────────────────────────
      // The exact text Claude sees — paste this into Claude directly to test
      aiPromptText: debugPayload.promptText,
    });
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return sendError(res, 500, message);
  } finally {
    delete process.env.CRAWLER_DEBUG_NO_LIMIT;
  }
}
