import axios from "axios";
import { crawlPages } from "./crawler";
import { fetchCloudflareCrawlPages } from "./cloudflareCrawl";
import type { CrawlError, PageData } from "./types";

const CLOUDFLARE_FALLBACK_BUDGET_MS = 50_000;

async function tryCloudflareOnce(
  baseUrl: string,
  signal: AbortSignal,
  message: string,
): Promise<{ pages: PageData[]; errors: CrawlError[] } | null> {
  if (signal.aborted) return null;

  const ctrl = new AbortController();
  const budgetMs = CLOUDFLARE_FALLBACK_BUDGET_MS;
  const timer = setTimeout(() => ctrl.abort(), budgetMs);
  try {
    const pages = await fetchCloudflareCrawlPages(
      baseUrl,
      ctrl.signal,
      budgetMs,
    );
    if (pages.length === 0) return null;
    return { pages, errors: [{ url: baseUrl, type: "blocked", message }] };
  } finally {
    clearTimeout(timer);
  }
}

const tryProtectedProviderOnce = tryCloudflareOnce;

/**
 * Fast probe for WAF / Cloudflare protection using ONLY status + headers.
 * This prevents wasting 30–40s in Playwright on sites that will never render
 * from a datacenter IP.
 */
async function probeProtection(
  url: string,
  signal: AbortSignal,
): Promise<{ protected: boolean; vendor: "cloudflare" | "waf" | null }> {
  try {
    const res = await axios.get<string>(url, {
      timeout: 3500,
      maxRedirects: 3,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      // Do not throw on 4xx/5xx — we want to inspect headers
      validateStatus: () => true,
      signal,
    });

    const status = res.status;
    const headers = res.headers;

    const server =
      typeof headers["server"] === "string" ? headers["server"] : "";
    const hasCf =
      typeof headers["cf-ray"] === "string" ||
      typeof headers["cf-cache-status"] === "string" ||
      server.toLowerCase().includes("cloudflare");

    const hasWafHint =
      typeof headers["x-sucuri-id"] === "string" ||
      typeof headers["x-sucuri-block"] === "string" ||
      typeof headers["x-akamai-transformed"] === "string" ||
      typeof headers["x-amzn-remapped-host"] === "string" ||
      typeof headers["x-amz-cf-id"] === "string";

    const looksBlocked =
      status === 401 || status === 403 || status === 429 || status === 503;

    if (looksBlocked && hasCf) return { protected: true, vendor: "cloudflare" };
    if (looksBlocked && hasWafHint) return { protected: true, vendor: "waf" };

    return { protected: false, vendor: null };
  } catch {
    // Probe failures should not block crawling; treat as unknown/not protected
    return { protected: false, vendor: null };
  }
}

/**
 * Fast local crawl first; if the site appears protected (Cloudflare/WAF),
 * use Cloudflare Browser Rendering crawl as the fallback.
 */
export async function hybridCrawl(
  baseUrl: string,
  signal: AbortSignal,
): Promise<{ pages: PageData[]; errors: CrawlError[] }> {
  const probe = await probeProtection(baseUrl, signal);

  // If we can quickly identify a protected site (Cloudflare/WAF), skip the
  // expensive Playwright path and go directly to Cloudflare crawl.
  if (probe.protected) {
    const msg =
      probe.vendor === "cloudflare"
        ? "Cloudflare protection detected — used Cloudflare crawl fallback"
        : "WAF protection detected — used Cloudflare crawl fallback";
    const result = await tryProtectedProviderOnce(baseUrl, signal, msg);
    if (result) return result;
    // If Cloudflare produced nothing, fall back to local crawl.
  }

  const primary = await crawlPages(baseUrl, signal);

  // Secondary Cloudflare fallback only when probe indicated protection.
  if (!probe.protected) return primary;

  const secondary = await tryProtectedProviderOnce(
    baseUrl,
    signal,
    "Protected site detected — used Cloudflare crawl fallback",
  );
  return secondary ?? primary;
}
