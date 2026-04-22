import axios from "axios";
import type { PageData, RobotsMeta } from "./types";

// ─── Public interface ─────────────────────────────────────────────────────────

export interface Layer1Signals {
  url: string;
  pagesCrawled: number;
  hasSitemap: boolean;
  robots: {
    gptBotAllowed: boolean | null;
    claudeBotAllowed: boolean | null;
  };
  technical: {
    hasMetaDescription: boolean;
    hasH1: boolean;
    hasSchema: boolean;
    hasGA4: boolean;
  };
  content: {
    blogPages: number;
    pagesWithDates: number;
  };
  conversion: {
    totalForms: number;
    totalCTAs: number;
    hasLeadMagnetSignals: boolean;
  };
  performance: {
    pageSpeedScore: number | null;
    mobileFriendly: boolean | null;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Realistic desktop UA for sitemap + PageSpeed requests.
// For JS-rendered pages blocked by Cloudflare, set HTTPS_PROXY to a
// residential rotating proxy (BrightData / Oxylabs / Smartproxy).
// Playwright-core reads HTTPS_PROXY automatically; axios needs a proxy
// adapter if you want to route sitemap/robots fetches through it too.
const CRAWL_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

const PAGESPEED_TIMEOUT_MS = 45_000;
const PAGESPEED_MAX_ATTEMPTS = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns the page whose pathname is "/" — the true homepage.
 * Falls back to the first page in the array when not found.
 */
export function resolveHomepage(pages: PageData[]): PageData | undefined {
  return (
    pages.find((p) => {
      try {
        return new URL(p.url).pathname === "/";
      } catch {
        return false;
      }
    }) ?? pages[0]
  );
}

/**
 * Checks whether /sitemap.xml exists and returns a 200 response.
 */
export async function checkSitemap(baseUrl: string): Promise<boolean> {
  try {
    const { origin } = new URL(baseUrl);
    await axios.get(`${origin}/sitemap.xml`, {
      timeout: 5000,
      headers: CRAWL_HEADERS,
      maxContentLength: 500_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Google PageSpeed Insights API (mobile strategy).
 * Returns null values on any failure — this is a best-effort signal.
 *
 * Set GOOGLE_PAGESPEED_KEY in environment for higher rate limits.
 * Works without a key at reduced rate limits.
 */
export async function fetchPageSpeed(
  url: string,
): Promise<{ pageSpeedScore: number | null; mobileFriendly: boolean | null }> {
  const key = process.env.GOOGLE_PAGESPEED_KEY;

  if (!key) {
    // Without an API key Google heavily rate-limits requests and they will
    // silently fail. Set GOOGLE_PAGESPEED_KEY in .env to enable this signal.
    console.warn("[layer1] GOOGLE_PAGESPEED_KEY not set — skipping PageSpeed");
    return { pageSpeedScore: null, mobileFriendly: null };
  }

  const apiUrl = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

  for (let attempt = 1; attempt <= PAGESPEED_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { data } = await axios.get<{
        lighthouseResult?: {
          categories?: { performance?: { score?: number | null } };
          // Lighthouse v10+ returns score: null for informative/n-a audits
          audits?: { viewport?: { score?: number | null } };
        };
      }>(apiUrl, {
        timeout: PAGESPEED_TIMEOUT_MS,
        params: {
          url,
          strategy: "mobile",
          key,
        },
      });

      const raw = data.lighthouseResult?.categories?.performance?.score;
      const pageSpeedScore =
        typeof raw === "number" ? Math.round(raw * 100) : null;

      // Lighthouse v12+ renamed "viewport" → "viewport-insight".
      // Try both so the code works across API versions.
      const audits = data.lighthouseResult?.audits as
        | Record<string, { score?: number | null }>
        | undefined;
      const viewport = audits?.["viewport-insight"] ?? audits?.["viewport"];

      // Score semantics:
      //   1    → viewport tag present and correct  → mobile friendly
      //   null → informative / not applicable      → treat as friendly
      //   0    → viewport tag missing or broken    → not mobile friendly
      const mobileFriendly =
        viewport !== undefined ? viewport.score !== 0 : null;

      return { pageSpeedScore, mobileFriendly };
    } catch (err) {
      const axiosErr = axios.isAxiosError(err) ? err : null;
      const status = axiosErr?.response?.status;
      const isTimeout =
        axiosErr?.code === "ECONNABORTED" ||
        axiosErr?.message.includes("timeout");
      const isRetriable =
        isTimeout || status === 429 || (status !== undefined && status >= 500);

      if (attempt < PAGESPEED_MAX_ATTEMPTS && isRetriable) {
        await sleep(1000 * attempt);
        continue;
      }

      const reason = isTimeout
        ? `timeout after ${PAGESPEED_TIMEOUT_MS}ms`
        : status !== undefined
          ? `HTTP ${status}`
          : axiosErr?.code || "network error";
      const detail = axiosErr?.message ?? (err instanceof Error ? err.message : String(err));

      console.error("[layer1] PageSpeed API error:", `${reason} — ${detail}`);
      return { pageSpeedScore: null, mobileFriendly: null };
    }
  }

  return { pageSpeedScore: null, mobileFriendly: null };
}

// ─── Signal extraction ────────────────────────────────────────────────────────

const DATE_REGEX =
  /\b(20\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;

const LEAD_MAGNET_REGEX = /free|download|guide|ebook|trial|demo/i;

/**
 * Extracts the pure technical + content + conversion signals synchronously.
 * Used by `scoring.ts` for Q2/Q3 without triggering any HTTP requests.
 */
export function extractTechnicalSignals(pages: PageData[], robots: RobotsMeta) {
  const homepage = resolveHomepage(pages);

  // ── Technical ────────────────────────────────────────────────────────────
  const technical = {
    hasMetaDescription: (homepage?.metaDescription.length ?? 0) > 0,
    hasH1: (homepage?.h1Tags.length ?? 0) > 0,
    hasSchema: (homepage?.schemas.length ?? 0) > 0,
    hasGA4: homepage?.ga4Id !== null && homepage?.ga4Id !== undefined,
  };

  // ── Content ──────────────────────────────────────────────────────────────
  const blogPages = pages.filter((p) =>
    /blog|article|post|news|insight/i.test(p.url),
  ).length;

  const pagesWithDates = pages.filter((p) =>
    DATE_REGEX.test(p.bodyText.slice(0, 500)),
  ).length;

  // ── Conversion ───────────────────────────────────────────────────────────
  const totalForms = pages.filter((p) => p.hasForm).length;
  const totalCTAs = pages.reduce((sum, p) => sum + p.ctaTexts.length, 0);
  const hasLeadMagnetSignals =
    totalForms > 0 &&
    pages.some((p) => p.ctaTexts.some((cta) => LEAD_MAGNET_REGEX.test(cta)));

  return {
    robots: {
      gptBotAllowed: robots.gptBotAllowed,
      claudeBotAllowed: robots.claudeBotAllowed,
    },
    technical,
    content: { blogPages, pagesWithDates },
    conversion: { totalForms, totalCTAs, hasLeadMagnetSignals },
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Collects ALL Layer 1 signals for a crawled site.
 *
 * Runs sitemap detection and Google PageSpeed in parallel with each other —
 * both are network calls independent of the crawl output.
 *
 * Always resolves (never throws) — performance fields fall back to null when
 * the PageSpeed API is unavailable or rate-limited.
 */
export async function collectLayer1Signals(
  url: string,
  pages: PageData[],
  robots: RobotsMeta,
  performancePromise?: Promise<{
    pageSpeedScore: number | null;
    mobileFriendly: boolean | null;
  }>,
): Promise<Layer1Signals> {
  const sync = extractTechnicalSignals(pages, robots);

  // Run async checks in parallel — they are independent of each other
  const [hasSitemap, performance] = await Promise.all([
    checkSitemap(url),
    performancePromise ?? fetchPageSpeed(url),
  ]);

  return {
    url,
    pagesCrawled: pages.length,
    hasSitemap,
    robots: sync.robots,
    technical: sync.technical,
    content: sync.content,
    conversion: sync.conversion,
    performance,
  };
}
