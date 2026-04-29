import axios from "axios";
import type { AxiosHeaderValue } from "axios";
import type {
  PageData,
  RobotsMeta,
  SchemaSignals,
  SocialProfiles,
} from "./types";

// ─── Public interface ─────────────────────────────────────────────────────────

export interface Layer1Signals {
  url: string;
  pagesCrawled: number;
  hasSitemap: boolean;
  robots: {
    gptBotAllowed: boolean | null;
    claudeBotAllowed: boolean | null;
    perplexityBotAllowed: boolean | null;
  };
  technical: {
    hasSchema: boolean;
    hasAnalyticsTracking: boolean;
    schemaTypes: SchemaSignals;
    latestDateModified: string | null;
    socialProfiles: SocialProfiles;
  };
  content: {
    blogPages: number;
    pagesWithDateModified: number;
  };
  conversion: {
    totalForms: number;
    totalCTAs: number;
    hasLeadMagnetSignals: boolean;
  };
  performance: {
    pageSpeedScore: number | null;
    mobileFriendly: boolean | null;
    error: string | null;
  };
}

export interface SitemapDiscoveryResult {
  sitemapUrls: string[];
  discoveredPageUrls: string[];
  blockedSitemapUrls: string[];
  urlLastmods: Record<string, string>;
  latestLastmod: string | null;
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
const SITEMAP_TIMEOUT_MS = 10_000;
const MAX_SITEMAP_FILES = 8;
const MAX_SITEMAP_URLS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptySocialProfiles(): SocialProfiles {
  return {
    linkedin: [],
    facebook: [],
    instagram: [],
    x: [],
    youtube: [],
    tiktok: [],
    pinterest: [],
  };
}

function mergeSocialProfiles(pages: PageData[]): SocialProfiles {
  const merged = emptySocialProfiles();

  for (const page of pages) {
    merged.linkedin.push(...page.socialProfiles.linkedin);
    merged.facebook.push(...page.socialProfiles.facebook);
    merged.instagram.push(...page.socialProfiles.instagram);
    merged.x.push(...page.socialProfiles.x);
    merged.youtube.push(...page.socialProfiles.youtube);
    merged.tiktok.push(...page.socialProfiles.tiktok);
    merged.pinterest.push(...page.socialProfiles.pinterest);
  }

  return {
    linkedin: [...new Set(merged.linkedin)],
    facebook: [...new Set(merged.facebook)],
    instagram: [...new Set(merged.instagram)],
    x: [...new Set(merged.x)],
    youtube: [...new Set(merged.youtube)],
    tiktok: [...new Set(merged.tiktok)],
    pinterest: [...new Set(merged.pinterest)],
  };
}

function extractSitemapUrlsFromRobots(robotsTxt: string): string[] {
  return robotsTxt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^sitemap:/i.test(line))
    .map((line) => line.replace(/^sitemap:\s*/i, "").trim())
    .filter(Boolean);
}

function extractXmlLocs(xml: string): string[] {
  const matches = [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)];
  return matches.map((match) => match[1].trim()).filter(Boolean);
}

function coerceIsoDate(value: string): string | null {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function pickLatestIsoDate(
  ...values: Array<string | null | undefined>
): string | null {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null
  );
}

function extractXmlUrlEntries(
  xml: string,
): Array<{ loc: string; lastmod: string | null }> {
  const entries: Array<{ loc: string; lastmod: string | null }> = [];
  const urlBlocks = [...xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)];

  for (const match of urlBlocks) {
    const block = match[1];
    const locMatch = block.match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i);
    const lastmodMatch = block.match(/<lastmod\b[^>]*>([\s\S]*?)<\/lastmod>/i);
    const loc = locMatch?.[1]?.trim();
    if (!loc) continue;

    entries.push({
      loc,
      lastmod: lastmodMatch?.[1]?.trim() ?? null,
    });
  }

  return entries;
}

function isCloudflareChallenge(
  status: number,
  headers: Record<string, AxiosHeaderValue | undefined>,
  data: string,
): boolean {
  const cfMitigated = headers["cf-mitigated"];
  const mitigatedValue = Array.isArray(cfMitigated)
    ? cfMitigated.join(",").toLowerCase()
    : typeof cfMitigated === "string"
      ? cfMitigated.toLowerCase()
      : "";

  return (
    status === 403 &&
    (mitigatedValue.includes("challenge") ||
      data.includes("Just a moment") ||
      data.includes("challenges.cloudflare.com"))
  );
}

async function fetchPlainText(url: string): Promise<string | null> {
  try {
    const { data, status, headers } = await axios.get<string>(url, {
      timeout: SITEMAP_TIMEOUT_MS,
      headers: CRAWL_HEADERS,
      maxRedirects: 5,
      maxContentLength: 1_000_000,
      validateStatus: () => true,
    });

    if (status < 200 || status >= 300 || typeof data !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

async function fetchXmlText(
  url: string,
): Promise<{ xml: string | null; blocked: boolean }> {
  try {
    const { data, status, headers } = await axios.get<string>(url, {
      timeout: SITEMAP_TIMEOUT_MS,
      headers: CRAWL_HEADERS,
      maxRedirects: 5,
      maxContentLength: 1_000_000,
      validateStatus: () => true,
    });

    if (typeof data !== "string") {
      return { xml: null, blocked: false };
    }

    if (isCloudflareChallenge(status, headers, data)) {
      return { xml: null, blocked: true };
    }

    if (status < 200 || status >= 300) {
      return { xml: null, blocked: false };
    }

    const contentType =
      typeof headers["content-type"] === "string"
        ? headers["content-type"].toLowerCase()
        : "";

    if (
      (!contentType.includes("xml") &&
        !data.includes("<urlset") &&
        !data.includes("<sitemapindex"))
    ) {
      return { xml: null, blocked: false };
    }

    return { xml: data, blocked: false };
  } catch {
    return { xml: null, blocked: false };
  }
}

export async function discoverSitemapUrls(baseUrl: string): Promise<string[]> {
  const result = await discoverSitemap(baseUrl);
  return result.discoveredPageUrls;
}

export async function discoverSitemap(
  baseUrl: string,
): Promise<SitemapDiscoveryResult> {
  const { origin } = new URL(baseUrl);
  const robotsTxt = await fetchPlainText(`${origin}/robots.txt`);

  const queue = Array.from(
    new Set([
      ...(robotsTxt ? extractSitemapUrlsFromRobots(robotsTxt) : []),
      `${origin}/sitemap.xml`,
      `${origin}/sitemap_index.xml`,
    ]),
  );

  const knownSitemapUrls = new Set<string>(
    robotsTxt ? extractSitemapUrlsFromRobots(robotsTxt) : [],
  );
  const blockedSitemapUrls = new Set<string>();
  const visitedSitemaps = new Set<string>();
  const discoveredPageUrls = new Set<string>();
  const urlLastmods = new Map<string, string>();
  let latestLastmod: string | null = null;

  while (queue.length > 0 && visitedSitemaps.size < MAX_SITEMAP_FILES) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || visitedSitemaps.has(sitemapUrl)) continue;
    visitedSitemaps.add(sitemapUrl);

    const { xml, blocked } = await fetchXmlText(sitemapUrl);
    if (blocked) {
      blockedSitemapUrls.add(sitemapUrl);
      continue;
    }

    if (!xml) continue;

    knownSitemapUrls.add(sitemapUrl);

    const locs = extractXmlLocs(xml);
    const urlEntries = extractXmlUrlEntries(xml);

    for (const entry of urlEntries) {
      const isoLastmod = entry.lastmod ? coerceIsoDate(entry.lastmod) : null;
      discoveredPageUrls.add(entry.loc);

      if (isoLastmod) {
        const previous = urlLastmods.get(entry.loc) ?? null;
        const next = pickLatestIsoDate(previous, isoLastmod);
        if (next) {
          urlLastmods.set(entry.loc, next);
          latestLastmod = pickLatestIsoDate(latestLastmod, next);
        }
      }

      if (discoveredPageUrls.size >= MAX_SITEMAP_URLS) {
        return {
          sitemapUrls: [...knownSitemapUrls],
          discoveredPageUrls: [...discoveredPageUrls],
          blockedSitemapUrls: [...blockedSitemapUrls],
          urlLastmods: Object.fromEntries(urlLastmods),
          latestLastmod,
        };
      }
    }

    for (const loc of locs) {
      if (/\.xml(?:\.gz)?$/i.test(loc)) {
        knownSitemapUrls.add(loc);
        if (!visitedSitemaps.has(loc)) queue.push(loc);
        continue;
      }

      discoveredPageUrls.add(loc);
      if (discoveredPageUrls.size >= MAX_SITEMAP_URLS) {
        return {
          sitemapUrls: [...knownSitemapUrls],
          discoveredPageUrls: [...discoveredPageUrls],
          blockedSitemapUrls: [...blockedSitemapUrls],
          urlLastmods: Object.fromEntries(urlLastmods),
          latestLastmod,
        };
      }
    }
  }

  return {
    sitemapUrls: [...knownSitemapUrls],
    discoveredPageUrls: [...discoveredPageUrls],
    blockedSitemapUrls: [...blockedSitemapUrls],
    urlLastmods: Object.fromEntries(urlLastmods),
    latestLastmod,
  };
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
  const result = await discoverSitemap(baseUrl);
  return (
    result.sitemapUrls.length > 0 || result.discoveredPageUrls.length > 0
  );
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
): Promise<{
  pageSpeedScore: number | null;
  mobileFriendly: boolean | null;
  error: string | null;
}> {
  const key = process.env.GOOGLE_PAGESPEED_KEY;

  if (!key) {
    const error = "GOOGLE_PAGESPEED_KEY not set";
    console.warn(`[layer1] ${error}`);
    return { pageSpeedScore: null, mobileFriendly: null, error };
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

      if (pageSpeedScore === null) {
        return {
          pageSpeedScore: null,
          mobileFriendly,
          error: "PageSpeed response missing performance score",
        };
      }

      return { pageSpeedScore, mobileFriendly, error: null };
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
      const detail =
        axiosErr?.message ?? (err instanceof Error ? err.message : String(err));
      const error = `${reason} — ${detail}`;

      console.error("[layer1] PageSpeed API error:", error);
      return { pageSpeedScore: null, mobileFriendly: null, error };
    }
  }

  return {
    pageSpeedScore: null,
    mobileFriendly: null,
    error: "PageSpeed API exhausted retries without success",
  };
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
  const socialProfiles = mergeSocialProfiles(pages);
  const latestDateModified =
    pages
      .map((page) => page.dateModified)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;

  // ── Technical ────────────────────────────────────────────────────────────
  const technical = {
    hasSchema:
      Boolean(homepage?.schemaSignals.faq) ||
      Boolean(homepage?.schemaSignals.productOrService) ||
      Boolean(homepage?.schemaSignals.localBusinessOrOrganization) ||
      Boolean(homepage?.schemaSignals.reviewOrAggregateRating),
    hasAnalyticsTracking: Boolean(homepage?.ga4Id || homepage?.gtmId),
    schemaTypes: {
      faq: pages.some((page) => page.schemaSignals.faq),
      productOrService: pages.some(
        (page) => page.schemaSignals.productOrService,
      ),
      localBusinessOrOrganization: pages.some(
        (page) => page.schemaSignals.localBusinessOrOrganization,
      ),
      reviewOrAggregateRating: pages.some(
        (page) => page.schemaSignals.reviewOrAggregateRating,
      ),
    },
    latestDateModified,
    socialProfiles,
  };

  // ── Content ──────────────────────────────────────────────────────────────
  const blogPages = pages.filter((p) =>
    /blog|article|post|news|insight|resource|latest/i.test(p.url),
  ).length;

  const pagesWithDateModified = pages.filter((p) =>
    Boolean(p.dateModified) || DATE_REGEX.test(p.bodyText.slice(0, 500)),
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
      perplexityBotAllowed: robots.perplexityBotAllowed,
    },
    technical,
    content: { blogPages, pagesWithDateModified },
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
    error: string | null;
  }>,
): Promise<Layer1Signals> {
  const sync = extractTechnicalSignals(pages, robots);

  // Run async checks in parallel — they are independent of each other
  const [sitemapResult, performance] = await Promise.all([
    discoverSitemap(url),
    performancePromise ?? fetchPageSpeed(url),
  ]);

  const hasSitemap =
    sitemapResult.sitemapUrls.length > 0 ||
    sitemapResult.discoveredPageUrls.length > 0;
  const latestDateModified = pickLatestIsoDate(
    sync.technical.latestDateModified,
    sitemapResult.latestLastmod,
  );

  return {
    url,
    pagesCrawled: pages.length,
    hasSitemap,
    robots: sync.robots,
    technical: {
      ...sync.technical,
      latestDateModified,
    },
    content: sync.content,
    conversion: sync.conversion,
    performance,
  };
}
