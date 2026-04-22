import axios from "axios";
import * as cheerio from "cheerio";
import type { PageData, CrawlError, ErrorType } from "./types";
import { parseHTML } from "./parser";
import { renderWithPlaywright } from "../utils/playwright";

// Realistic browser UA — many sites actively block bot-identified agents
const CRAWL_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
};

const DEFAULT_MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB
const REQUEST_TIMEOUT_MS = 8000;
// Must cover: nav timeout (20 s) + CF challenge wait (15 s) + settle (2 s).
const PLAYWRIGHT_WRAPPER_TIMEOUT_MS = 40000;
const MAX_PAGES = 6;
const CONCURRENCY = 3;
const RETRY_DELAY_MS = 500;

/**
 * Priority sub-paths (partial match). Earlier entries win.
 */
const PRIORITY_PATHS = [
  "/about",
  "/services",
  "/blog",
  "/resources",
  "/portfolio",
  "/contact",
];

// ─── URL helpers ──────────────────────────────────────────────────────────────

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

// ─── Error classification ─────────────────────────────────────────────────────

function classifyError(err: unknown): { type: ErrorType; message: string } {
  if (axios.isAxiosError(err)) {
    if (
      err.code === "ECONNABORTED" ||
      err.message.toLowerCase().includes("timeout")
    ) {
      return { type: "timeout", message: "Request timed out" };
    }
    const status = err.response?.status;
    if (status === 404) {
      return {
        type: "not_found",
        message:
          "Page not found (404) — likely a client-side SPA route without server-level routing",
      };
    }
    if (status === 401 || status === 403 || status === 429) {
      return { type: "blocked", message: `Access denied (HTTP ${status})` };
    }
    if (status !== undefined && status >= 500) {
      return { type: "server_error", message: `Server error (HTTP ${status})` };
    }
  }
  return {
    type: "unknown",
    message: err instanceof Error ? err.message : "Unknown error",
  };
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

/**
 * Fetches raw HTML with one automatic retry on failure.
 * Respects the global AbortSignal. Slices oversized responses early so large
 * HTML never bloats memory downstream.
 */
async function fetchHTML(url: string, signal: AbortSignal): Promise<string> {
  const debugNoLimit = process.env.CRAWLER_DEBUG_NO_LIMIT === "1";
  let lastErr: unknown;

  for (let attempt = 0; attempt <= 1; attempt++) {
    if (signal.aborted) throw new Error("Global timeout exceeded");
    try {
      const { data } = await axios.get<string>(url, {
        timeout: REQUEST_TIMEOUT_MS,
        // -1 = unlimited (axios). Only enable for debug mode.
        maxContentLength: debugNoLimit ? -1 : DEFAULT_MAX_HTML_BYTES,
        maxRedirects: 5,
        headers: CRAWL_HEADERS,
        signal,
      });

      // Trim early in normal mode — avoids allocating large strings downstream.
      // In debug mode, return the full HTML.
      if (typeof data === "string") {
        return debugNoLimit ? data : data.slice(0, DEFAULT_MAX_HTML_BYTES);
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (signal.aborted) break;
      if (attempt === 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, RETRY_DELAY_MS),
        );
      }
    }
  }

  throw lastErr;
}

// ─── Playwright wrapper ───────────────────────────────────────────────────────

/**
 * Wraps renderWithPlaywright with a hard external timeout.
 * Playwright does not respect AbortSignal, so we race it against a timer
 * that resolves null (not rejects) so the caller can fall back gracefully.
 */
async function renderWithTimeout(url: string): Promise<string | null> {
  return Promise.race([
    renderWithPlaywright(url),
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), PLAYWRIGHT_WRAPPER_TIMEOUT_MS),
    ),
  ]);
}

// ─── Concurrency limiter ──────────────────────────────────────────────────────

async function withConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const i = cursor++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (err) {
        results[i] = { status: "rejected", reason: err };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker),
  );
  return results;
}

// ─── Link extraction ──────────────────────────────────────────────────────────

/**
 * Returns deduplicated same-domain absolute URLs found in the given HTML.
 * Strips leading "www." before comparing so that example.com and
 * www.example.com are treated as the same site, and blog.example.com
 * is accepted as a subdomain while notexample.com is not.
 */
function extractSameDomainLinks(html: string, baseUrl: string): string[] {
  const baseHost = new URL(baseUrl).hostname.replace(/^www\./, "");
  const seen = new Set<string>();
  const links: string[] = [];

  const $ = cheerio.load(html);
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const resolved = new URL(href, baseUrl);
      if (!["http:", "https:"].includes(resolved.protocol)) return;

      const linkHost = resolved.hostname.replace(/^www\./, "");
      if (linkHost !== baseHost && !linkHost.endsWith(`.${baseHost}`)) return;

      resolved.hash = "";
      if (seen.has(resolved.href)) return;
      seen.add(resolved.href);
      links.push(resolved.href);
    } catch {
      // Malformed URL — skip silently
    }
  });

  return links;
}

// ─── Link scoring ─────────────────────────────────────────────────────────────

/**
 * Rates a URL by how likely it is to contain high-value content for scoring.
 * Higher = fetched first. Shallow paths score well because deep nesting
 * usually means paginated posts or user-generated content.
 */
function scoreLink(url: string): number {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return 0;
  }

  let score = 0;
  if (path === "/" || path === "") score += 100;
  if (path.includes("about")) score += 80;
  if (path.includes("service")) score += 80;
  if (path.includes("blog")) score += 70;
  if (path.split("/").length <= 3) score += 50; // shallow path = usually more important

  return score;
}

// ─── Sitemap discovery ────────────────────────────────────────────────────────

/**
 * Fetches /sitemap.xml and extracts all <loc> URLs.
 * Never throws — returns an empty array on any failure.
 */
async function fetchSitemapUrls(baseUrl: string): Promise<string[]> {
  try {
    const { origin } = new URL(baseUrl);
    const { data } = await axios.get<string>(`${origin}/sitemap.xml`, {
      timeout: 5000,
      headers: CRAWL_HEADERS,
    });

    const matches = (data as string).match(/<loc>(.*?)<\/loc>/g) ?? [];
    return matches.map((m) => m.replace(/<\/?loc>/g, "").trim());
  } catch {
    return [];
  }
}

// ─── Main crawl ───────────────────────────────────────────────────────────────

export async function crawlPages(
  baseUrl: string,
  signal: AbortSignal,
): Promise<{ pages: PageData[]; errors: CrawlError[] }> {
  const pages: PageData[] = [];
  const errors: CrawlError[] = [];

  // Per-crawl deduplication cache.
  // Prevents the same URL being fetched twice if it appears in both
  // the anchor link list and the sitemap (common for top-level pages).
  const htmlFetchPromiseCache = new Map<string, Promise<string>>();

  function fetchHtmlOnce(url: string): Promise<string> {
    if (!htmlFetchPromiseCache.has(url)) {
      htmlFetchPromiseCache.set(url, fetchHTML(url, signal));
    }
    return htmlFetchPromiseCache.get(url)!;
  }

  // Step 1 — fetch homepage HTML.
  // If axios is blocked (403/401/429) or the page looks like a JS shell,
  // fall back to Playwright before giving up. This handles sites behind
  // Cloudflare JS challenges and other bot-detection layers.
  let homepageHtml: string;
  let wasJSSite = false;

  try {
    homepageHtml = await fetchHtmlOnce(baseUrl);
  } catch (err) {
    const classified = classifyError(err);
    // Blocked by WAF/CDN — try Playwright as a last resort
    if (classified.type === "blocked") {
      const rendered = await renderWithTimeout(baseUrl);
      if (rendered) {
        homepageHtml = rendered;
        wasJSSite = true; // treat sub-pages the same way
      } else {
        errors.push({ url: baseUrl, ...classified });
        return { pages, errors };
      }
    } else {
      errors.push({ url: baseUrl, ...classified });
      return { pages, errors };
    }
  }

  // Step 2 — JS-site detection: if axios succeeded, check if the page is a
  // JS shell (empty body) and attempt Playwright render.
  // wasJSSite is captured BEFORE Playwright re-renders — after rendering
  // isJSSite flips false, so we must remember the original value to drive
  // the sub-page strategy below.
  if (!wasJSSite) {
    const quickParse = parseHTML(homepageHtml, baseUrl);
    wasJSSite = quickParse.isJSSite;
    if (wasJSSite) {
      const rendered = await renderWithTimeout(baseUrl);
      if (rendered) homepageHtml = rendered;
    }
  }

  pages.push(parseHTML(homepageHtml, baseUrl));

  // Step 3 — discover same-domain links + sitemap in parallel
  const [sameDomainLinks, sitemapLinks] = await Promise.all([
    Promise.resolve(extractSameDomainLinks(homepageHtml, baseUrl)),
    fetchSitemapUrls(baseUrl),
  ]);

  const { origin, hostname: baseHostname } = new URL(baseUrl);
  const homepageHref = `${origin}/`;
  // Filter sitemap entries to same domain (sitemaps can reference CDN paths)
  const baseHost = new URL(baseUrl).hostname.replace(/^www\./, "");
  const filteredSitemapLinks = sitemapLinks.filter((u) => {
    try {
      const h = new URL(u).hostname.replace(/^www\./, "");
      return h === baseHost || h.endsWith(`.${baseHost}`);
    } catch {
      return false;
    }
  });

  // Priority match via partial path inclusion
  const prioritized = PRIORITY_PATHS.flatMap((path) =>
    sameDomainLinks.filter((link) => {
      try {
        return new URL(link).pathname.includes(path);
      } catch {
        return false;
      }
    }),
  );

  // Score remaining anchor links by content value rather than URL length
  const remaining = sameDomainLinks
    .filter((l) => !prioritized.includes(l) && l !== homepageHref)
    .sort((a, b) => scoreLink(b) - scoreLink(a));

  // Merge anchor links + sitemap; deduplicate
  const allCandidates = [
    ...new Set([...prioritized, ...remaining, ...filteredSitemapLinks]),
  ];

  // For JS SPAs, same-origin sub-paths are client-side routes — the server
  // returns 404 for them even in a real browser. Only subdomain pages
  // (e.g. blog.pfscores.com) are separate server deployments worth crawling.
  const urlsToFetch = wasJSSite
    ? allCandidates.filter((u) => {
        try {
          return new URL(u).hostname !== baseHostname;
        } catch {
          return false;
        }
      })
    : allCandidates;

  const cappedUrls = urlsToFetch.slice(0, MAX_PAGES - 1);

  // Step 4 — crawl sub-pages with bounded concurrency.
  // For JS sites: first try plain axios; only launch Playwright if the page
  // still looks like a JS shell after the axios fetch. This avoids an
  // expensive browser launch for every sub-page.
  const subPageConcurrency = wasJSSite ? 1 : CONCURRENCY;

  const settled = await withConcurrency(
    cappedUrls.map((url) => async (): Promise<PageData> => {
      const html = await fetchHtmlOnce(url);

      if (wasJSSite) {
        const parsed = parseHTML(html, url);
        if (parsed.isJSSite) {
          const rendered = await renderWithTimeout(url);
          return parseHTML(rendered ?? html, url);
        }
        return parsed;
      }

      return parseHTML(html, url);
    }),
    subPageConcurrency,
  );

  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      pages.push(result.value);
    } else {
      const { type, message } = classifyError(result.reason);
      errors.push({ url: cappedUrls[i], type, message });
    }
  });

  return { pages, errors };
}
