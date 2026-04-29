import axios from "axios";
import * as cheerio from "cheerio";
import {
  fetchCloudflareCrawlResult,
  isCloudflareChallengeHtml,
} from "./cloudflareCrawl";
import { discoverSitemapUrls } from "./layer1";
import { parseHTML } from "./parser";
import { PAGE_TYPE_RULES } from "./pageSelectionRules";
import { renderWithPlaywright } from "./playwright";
import type { CrawlError, ErrorType, PageData } from "./types";

const CRAWL_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml",
};

const DEFAULT_MAX_HTML_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const PLAYWRIGHT_WRAPPER_TIMEOUT_MS = 40000;
const MAX_PAGES = 15;
const PROBE_CONCURRENCY = 4;
const FETCH_CONCURRENCY = 3;
const RETRY_DELAY_MS = 500;

interface LinkCandidate {
  url: string;
  anchorText: string;
  isNav: boolean;
  order: number;
}

interface ProtectionProbeResult {
  protected: boolean;
  vendor: "cloudflare" | "waf" | null;
}

interface PageArtifact {
  html: string;
  page: PageData;
  source: "local" | "playwright" | "cloudflare";
}

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function canonicalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    if (
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
    ) {
      url.port = "";
    }
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function classifyError(err: unknown): { type: ErrorType; message: string } {
  if (err instanceof Error) {
    const lowered = err.message.toLowerCase();
    if (
      lowered.includes("cloudflare content returned no html") ||
      lowered.includes("cloudflare content returned challenge page") ||
      lowered.includes(
        "cloudflare content returned challenge page or no html",
      ) ||
      lowered.includes("cloudflare content rate limited")
    ) {
      return { type: "blocked", message: err.message };
    }
  }

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

function isChallengePageHtml(html: string): boolean {
  return isCloudflareChallengeHtml(html);
}

function logCrawlFailure(url: string, stage: string, err: unknown): void {
  const classified = classifyError(err);

  if (
    err instanceof Error &&
    (err.message === "Cloudflare content fetch returned no HTML" ||
      err.message ===
        "Cloudflare content returned challenge page or no HTML") &&
    stage === "page-fetch"
  ) {
    return;
  }

  if (axios.isAxiosError(err)) {
    const headers = err.response?.headers ?? {};
    const bodyPreview =
      typeof err.response?.data === "string"
        ? err.response.data.replace(/\s+/g, " ").slice(0, 240)
        : null;

    console.error("[crawl] request failed", {
      stage,
      url,
      type: classified.type,
      message: classified.message,
      axiosCode: err.code ?? null,
      status: err.response?.status ?? null,
      server: typeof headers["server"] === "string" ? headers["server"] : null,
      cfRay: typeof headers["cf-ray"] === "string" ? headers["cf-ray"] : null,
      cfMitigated:
        typeof headers["cf-mitigated"] === "string"
          ? headers["cf-mitigated"]
          : null,
      contentType:
        typeof headers["content-type"] === "string"
          ? headers["content-type"]
          : null,
      bodyPreview,
    });
    return;
  }

  console.error("[crawl] request failed", {
    stage,
    url,
    type: classified.type,
    message: classified.message,
    error:
      err instanceof Error ? { name: err.name, message: err.message } : err,
  });
}

async function fetchHTML(
  url: string,
  signal: AbortSignal,
): Promise<{ html: string; lastModified: string | null }> {
  const debugNoLimit = process.env.CRAWLER_DEBUG_NO_LIMIT === "1";
  let lastErr: unknown;

  for (let attempt = 0; attempt <= 1; attempt++) {
    if (signal.aborted) throw new Error("Global timeout exceeded");
    try {
      const { data, headers } = await axios.get<string>(url, {
        timeout: REQUEST_TIMEOUT_MS,
        maxContentLength: debugNoLimit ? -1 : DEFAULT_MAX_HTML_BYTES,
        maxRedirects: 5,
        headers: CRAWL_HEADERS,
        signal,
      });

      if (typeof data === "string") {
        if (isChallengePageHtml(data)) {
          throw new Error("Cloudflare verification page returned");
        }
        return {
          html: debugNoLimit ? data : data.slice(0, DEFAULT_MAX_HTML_BYTES),
          lastModified:
            typeof headers["last-modified"] === "string"
              ? headers["last-modified"]
              : null,
        };
      }
      return {
        html: data,
        lastModified:
          typeof headers["last-modified"] === "string"
            ? headers["last-modified"]
            : null,
      };
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

async function renderWithTimeout(url: string): Promise<string | null> {
  return Promise.race([
    renderWithPlaywright(url),
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), PLAYWRIGHT_WRAPPER_TIMEOUT_MS),
    ),
  ]);
}

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

function extractSameDomainLinks(
  html: string,
  baseUrl: string,
): LinkCandidate[] {
  const baseHost = new URL(baseUrl).hostname.replace(/^www\./, "");
  const seen = new Set<string>();
  const links: LinkCandidate[] = [];

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

      links.push({
        url: resolved.href,
        anchorText: $(el).text().replace(/\s+/g, " ").trim().toLowerCase(),
        isNav: $(el).closest("nav, header").length > 0,
        order: links.length,
      });
    } catch {
      // Skip malformed URLs.
    }
  });

  return links;
}

function scoreLink(url: string): number {
  try {
    const pathname = new URL(url).pathname.toLowerCase().replace(/\/$/, "");
    const segments = pathname.split("/").filter(Boolean);
    let score = 0;

    if (pathname === "" || pathname === "/") score += 120;
    if (segments.length <= 2) score += 60;
    else if (segments.length === 3) score += 30;

    const allSlugRules = Object.values(PAGE_TYPE_RULES).flatMap(
      (rule) => rule.slugs,
    );
    if (matchesSlug(pathname, allSlugRules)) score += 50;
    if (/tag|category|author|page\/\d+/i.test(pathname)) score -= 40;

    return score;
  } catch {
    return 0;
  }
}

function matchesNavText(text: string, values: readonly string[]): boolean {
  return values.some((value) => text === value || text.includes(value));
}

function matchesSlug(pathname: string, values: readonly string[]): boolean {
  return values.some(
    (value) => pathname === value || pathname.startsWith(`${value}/`),
  );
}

function matchesPageType(
  candidate: Pick<LinkCandidate, "anchorText" | "url">,
  type: keyof typeof PAGE_TYPE_RULES,
): boolean {
  const rule = PAGE_TYPE_RULES[type];
  let pathname = "";

  try {
    pathname = new URL(candidate.url).pathname.toLowerCase().replace(/\/$/, "");
  } catch {
    return false;
  }

  const anchorText = candidate.anchorText.toLowerCase();
  return (
    matchesNavText(anchorText, rule.navTexts) ||
    matchesSlug(pathname, rule.slugs)
  );
}

function rankCandidate(
  candidate: LinkCandidate,
  type?: keyof typeof PAGE_TYPE_RULES,
): number {
  let score = scoreLink(candidate.url);

  if (candidate.isNav) score += 50;
  if (candidate.anchorText.length > 0) score += 10;
  score += Math.max(0, 20 - candidate.order);

  if (type && matchesPageType(candidate, type)) {
    score += 120;
  }

  return score;
}

function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const url of urls) {
    const canonical = canonicalizeUrl(url);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    deduped.push(url);
  }

  return deduped;
}

function selectTopCandidate(
  candidates: LinkCandidate[],
  type: keyof typeof PAGE_TYPE_RULES,
  exclude: Set<string>,
): string | null {
  const match = candidates
    .filter((candidate) => !exclude.has(candidate.url))
    .filter((candidate) => matchesPageType(candidate, type))
    .sort((a, b) => rankCandidate(b, type) - rankCandidate(a, type))[0];

  return match?.url ?? null;
}

function isDirectChildPage(parentUrl: string, candidateUrl: string): boolean {
  try {
    const parent = new URL(parentUrl);
    const child = new URL(candidateUrl);
    if (parent.hostname !== child.hostname) return false;

    const parentPath = parent.pathname.replace(/\/$/, "");
    const childPath = child.pathname.replace(/\/$/, "");
    if (!parentPath || childPath === parentPath) return false;
    if (!childPath.startsWith(`${parentPath}/`)) return false;

    const remainder = childPath.slice(parentPath.length + 1);
    return remainder.length > 0 && !remainder.includes("/");
  } catch {
    return false;
  }
}

function isLikelyBlogPost(
  listingUrl: string,
  candidate: LinkCandidate,
): boolean {
  try {
    const listingPath = new URL(listingUrl).pathname.replace(/\/$/, "");
    const path = new URL(candidate.url).pathname.replace(/\/$/, "");
    if (path === listingPath) return false;
    if (candidate.isNav) return false;
    if (/tag|category|author|page\/\d+/i.test(path)) return false;

    if (
      path.startsWith(`${listingPath}/`) ||
      /\b(20\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(
        candidate.anchorText,
      )
    ) {
      return true;
    }

    const segments = path.split("/").filter(Boolean);
    return segments.length >= 2;
  } catch {
    return false;
  }
}

function mergeCandidateLists(
  baseUrl: string,
  homepageLinks: LinkCandidate[],
  sitemapLinks: string[],
): LinkCandidate[] {
  const { origin } = new URL(baseUrl);
  const homepageHref = `${origin}/`;
  const baseHost = new URL(baseUrl).hostname.replace(/^www\./, "");
  const baseCanonical = canonicalizeUrl(baseUrl);
  const homepageCanonical = canonicalizeUrl(homepageHref);

  const sitemapCandidates = sitemapLinks
    .filter((url) => {
      try {
        const host = new URL(url).hostname.replace(/^www\./, "");
        return host === baseHost || host.endsWith(`.${baseHost}`);
      } catch {
        return false;
      }
    })
    .map(
      (url, index): LinkCandidate => ({
        url,
        anchorText: "",
        isNav: false,
        order: homepageLinks.length + index,
      }),
    );

  const merged = new Map<string, LinkCandidate>();
  for (const candidate of [...homepageLinks, ...sitemapCandidates]) {
    const candidateCanonical = canonicalizeUrl(candidate.url);
    if (
      candidateCanonical === baseCanonical ||
      candidateCanonical === homepageCanonical ||
      merged.has(candidateCanonical)
    ) {
      const existing = merged.get(candidateCanonical);
      if (!existing || rankCandidate(candidate) > rankCandidate(existing)) {
        merged.set(candidateCanonical, candidate);
      }
      continue;
    }
    merged.set(candidateCanonical, candidate);
  }

  return [...merged.values()];
}

function buildPlannedUrlOrder(
  candidates: LinkCandidate[],
  baseUrl: string,
  wasJSSite: boolean,
): {
  coreUrls: string[];
  fillUrls: string[];
} {
  const baseHostname = new URL(baseUrl).hostname;
  const filteredCandidates = wasJSSite
    ? candidates.filter((candidate) => {
        try {
          return new URL(candidate.url).hostname !== baseHostname;
        } catch {
          return false;
        }
      })
    : candidates;

  const selected = new Set<string>();
  const coreUrls = [
    selectTopCandidate(filteredCandidates, "about", selected),
    selectTopCandidate(filteredCandidates, "services", selected),
    selectTopCandidate(filteredCandidates, "blog", selected),
    selectTopCandidate(filteredCandidates, "caseStudies", selected),
    selectTopCandidate(filteredCandidates, "testimonials", selected),
  ].filter((url): url is string => Boolean(url));

  coreUrls.forEach((url) => selected.add(url));

  const fillUrls = filteredCandidates
    .filter((candidate) => !selected.has(candidate.url))
    .sort((a, b) => rankCandidate(b) - rankCandidate(a))
    .map((candidate) => candidate.url);

  return { coreUrls, fillUrls };
}

export async function probeProtection(
  url: string,
  signal: AbortSignal,
): Promise<ProtectionProbeResult> {
  try {
    const inspectResponse = (
      status: number,
      headers: Record<string, unknown>,
      body: string,
    ): ProtectionProbeResult => {
      const server =
        typeof headers["server"] === "string" ? headers["server"] : "";
      const hasCf =
        typeof headers["cf-ray"] === "string" ||
        typeof headers["cf-cache-status"] === "string" ||
        typeof headers["cf-mitigated"] === "string" ||
        server.toLowerCase().includes("cloudflare");
      const hasWafHint =
        typeof headers["x-sucuri-id"] === "string" ||
        typeof headers["x-sucuri-block"] === "string" ||
        typeof headers["x-akamai-transformed"] === "string" ||
        typeof headers["x-amzn-remapped-host"] === "string" ||
        typeof headers["x-amz-cf-id"] === "string";

      const normalizedBody = body.toLowerCase().slice(0, 500);
      const cfChallengeBody = isChallengePageHtml(normalizedBody);
      const looksBlocked =
        status === 401 || status === 403 || status === 429 || status === 503;

      if ((looksBlocked || cfChallengeBody) && hasCf) {
        return { protected: true, vendor: "cloudflare" };
      }
      if (looksBlocked && hasWafHint) {
        return { protected: true, vendor: "waf" };
      }

      return { protected: false, vendor: null };
    };

    const headRes = await axios.head(url, {
      timeout: 3500,
      maxRedirects: 3,
      headers: CRAWL_HEADERS,
      validateStatus: () => true,
      signal,
    });

    const headProbe = inspectResponse(headRes.status, headRes.headers, "");
    if (headProbe.protected) {
      return headProbe;
    }

    const res = await axios.get<string>(url, {
      timeout: 3500,
      maxRedirects: 3,
      headers: CRAWL_HEADERS,
      validateStatus: () => true,
      signal,
    });

    return inspectResponse(
      res.status,
      res.headers,
      typeof res.data === "string" ? res.data : "",
    );
  } catch {
    return { protected: false, vendor: null };
  }
}

async function fetchLocalArtifact(
  url: string,
  signal: AbortSignal,
): Promise<PageArtifact> {
  const { html, lastModified } = await fetchHTML(url, signal);
  if (isChallengePageHtml(html)) {
    throw new Error("Cloudflare verification page returned");
  }
  const parsed = parseHTML(html, url, {
    httpLastModified: lastModified,
  });

  if (parsed.isJSSite) {
    const rendered = await renderWithTimeout(url);
    if (rendered && !isChallengePageHtml(rendered)) {
      return {
        html: rendered,
        page: parseHTML(rendered, url, {
          httpLastModified: lastModified,
        }),
        source: "playwright",
      };
    }
  }

  return {
    html,
    page: parsed,
    source: "local",
  };
}

async function fetchHomepageArtifact(
  baseUrl: string,
  signal: AbortSignal,
): Promise<PageArtifact> {
  try {
    const artifact = await fetchLocalArtifact(baseUrl, signal);
    console.log("[crawl] homepage fetched", {
      url: baseUrl,
      source: artifact.source,
    });
    return artifact;
  } catch (err) {
    logCrawlFailure(baseUrl, "homepage-fetch", err);
    const rendered = await renderWithTimeout(baseUrl);
    if (rendered && !isChallengePageHtml(rendered)) {
      const artifact: PageArtifact = {
        html: rendered,
        page: parseHTML(rendered, baseUrl),
        source: "playwright",
      };
      console.log("[crawl] homepage fetched", {
        url: baseUrl,
        source: artifact.source,
      });
      return artifact;
    }

    throw err;
  }
}

export async function crawlPages(
  baseUrl: string,
  signal: AbortSignal,
): Promise<{ pages: PageData[]; errors: CrawlError[] }> {
  const pages: PageData[] = [];
  const errors: CrawlError[] = [];
  console.log(`[crawl] Starting crawl for ${baseUrl}`);
  const pageUrlSet = new Set<string>();
  const failedUrlSet = new Set<string>();
  let usedCloudflareSeedCrawl = false;
  const homepageProbe = await probeProtection(baseUrl, signal);

  if (homepageProbe.protected) {
    console.log("[crawl] homepage probe blocked, switching directly to Cloudflare", {
      baseUrl,
      vendor: homepageProbe.vendor,
    });

    const cloudflareResult = await fetchCloudflareCrawlResult(baseUrl, signal);
    return {
      pages: cloudflareResult.pages.slice(0, MAX_PAGES),
      errors: cloudflareResult.errors,
    };
  }

  const homepageArtifact = await fetchHomepageArtifact(baseUrl, signal).catch(
    async (err) => {
      const classified = classifyError(err);
      errors.push({ url: baseUrl, ...classified });
      return null;
    },
  );

  if (!homepageArtifact) {
    return { pages, errors };
  }

  const homepageCanonical = canonicalizeUrl(homepageArtifact.page.url);
  if (!pageUrlSet.has(homepageCanonical)) {
    pages.push(homepageArtifact.page);
    pageUrlSet.add(homepageCanonical);
  }

  const [homepageLinks, sitemapLinks] = await Promise.all([
    Promise.resolve(extractSameDomainLinks(homepageArtifact.html, baseUrl)),
    discoverSitemapUrls(baseUrl),
  ]);

  const candidates = mergeCandidateLists(baseUrl, homepageLinks, sitemapLinks);
  const { coreUrls, fillUrls } = buildPlannedUrlOrder(
    candidates,
    baseUrl,
    homepageArtifact.page.isJSSite,
  );

  console.log("[crawl] candidate discovery summary", {
    homepageLinks: homepageLinks.length,
    sitemapLinks: sitemapLinks.length,
    mergedCandidates: candidates.length,
    coreUrls,
  });

  const probeCache = new Map<string, Promise<ProtectionProbeResult>>();
  const artifactCache = new Map<string, Promise<PageArtifact>>();
  const artifacts = new Map<string, PageArtifact>();
  const cloudflareSeededCanonicalUrls = new Set<string>();

  function probeUrl(url: string): Promise<ProtectionProbeResult> {
    const canonical = canonicalizeUrl(url);
    if (!probeCache.has(canonical)) {
      probeCache.set(canonical, probeProtection(url, signal));
    }
    return probeCache.get(canonical)!;
  }

  async function fetchSelectedArtifact(url: string): Promise<PageArtifact> {
    const canonical = canonicalizeUrl(url);
    if (!artifactCache.has(canonical)) {
      artifactCache.set(
        canonical,
        (async () => {
          try {
            const artifact = await fetchLocalArtifact(url, signal);
            artifacts.set(canonical, artifact);
            return artifact;
          } catch (err) {
            throw err;
          }
        })(),
      );
    }

    return artifactCache.get(canonical)!;
  }

  async function fetchUrlBatch(urls: string[]): Promise<void> {
    if (urls.length === 0) return;

    const uniqueUrls = dedupeUrls(urls).filter((url) => {
      const canonical = canonicalizeUrl(url);
      return !artifacts.has(canonical) && !failedUrlSet.has(canonical);
    });
    if (uniqueUrls.length === 0) return;

    const probeResults = await withConcurrency(
      uniqueUrls.map((url) => async () => ({
        url,
        probe: await probeUrl(url),
      })),
      PROBE_CONCURRENCY,
    );

    const protectedUrls: string[] = [];
    const unprotectedUrls: string[] = [];

    probeResults.forEach((result, index) => {
      const url = uniqueUrls[index];
      if (result.status === "fulfilled" && result.value.probe.protected) {
        protectedUrls.push(url);
      } else {
        unprotectedUrls.push(url);
      }
    });

    if (protectedUrls.length > 0) {
      const protectedSeedUrl = protectedUrls[0];
      usedCloudflareSeedCrawl = true;
      protectedUrls.forEach((url) =>
        cloudflareSeededCanonicalUrls.add(canonicalizeUrl(url)),
      );
      console.log(
        "[crawl] protected shortlist detected, using Cloudflare content batch",
        {
          startUrl: baseUrl,
          protectedSeedUrl,
          protectedCandidates: protectedUrls.length,
        },
      );

      const cloudflareResult = await fetchCloudflareCrawlResult(baseUrl, signal);

      for (const page of cloudflareResult.pages) {
        const canonical = canonicalizeUrl(page.url);
        if (pageUrlSet.has(canonical)) continue;
        pages.push(page);
        pageUrlSet.add(canonical);
      }

      errors.push(...cloudflareResult.errors);
    }

    const runFetches = async (
      batchUrls: string[],
      concurrency: number,
    ): Promise<
      Array<
        | { url: string; artifact: PageArtifact }
        | { url: string; error: unknown }
      >
    > => {
      const settled = await withConcurrency(
        batchUrls.map((url) => async () => {
          const artifact = await fetchSelectedArtifact(url);
          return { url, artifact };
        }),
        concurrency,
      );

      return settled.map((result, index) =>
        result.status === "fulfilled"
          ? result.value
          : { url: batchUrls[index], error: result.reason },
      );
    };

    const results = await runFetches(unprotectedUrls, FETCH_CONCURRENCY);

    for (const result of results) {
      if ("artifact" in result) {
        const canonical = canonicalizeUrl(result.artifact.page.url);
        if (!pageUrlSet.has(canonical)) {
          pages.push(result.artifact.page);
          pageUrlSet.add(canonical);
        }
        continue;
      }

      failedUrlSet.add(canonicalizeUrl(result.url));
      logCrawlFailure(result.url, "page-fetch", result.error);
      const { type, message } = classifyError(result.error);
      errors.push({ url: result.url, type, message });
    }
  }

  const reservedFollowupSlots = 4;
  const initialBudget = Math.max(
    0,
    MAX_PAGES - pages.length - reservedFollowupSlots,
  );
  const initialUrls = dedupeUrls([...coreUrls, ...fillUrls]).slice(
    0,
    initialBudget,
  );
  console.log("[crawl] initial page plan", {
    count: initialUrls.length,
    urls: initialUrls,
  });

  await fetchUrlBatch(initialUrls);

  const crawledUrlSet = new Set([...pageUrlSet]);
  const remainingCapacity = () => Math.max(0, MAX_PAGES - pages.length);

  const servicesPage = pages.find((page) =>
    matchesPageType(
      { url: page.url, anchorText: page.title.toLowerCase() },
      "services",
    ),
  );

  if (!usedCloudflareSeedCrawl && servicesPage && remainingCapacity() > 0) {
    const serviceArtifact = artifacts.get(canonicalizeUrl(servicesPage.url));
    if (serviceArtifact) {
      const serviceUrls = extractSameDomainLinks(
        serviceArtifact.html,
        servicesPage.url,
      )
        .filter((candidate) =>
          isDirectChildPage(servicesPage.url, candidate.url),
        )
        .sort((a, b) => rankCandidate(b) - rankCandidate(a))
        .map((candidate) => candidate.url)
        .filter((url) => !crawledUrlSet.has(canonicalizeUrl(url)))
        .filter((url) => !failedUrlSet.has(canonicalizeUrl(url)))
        .slice(0, Math.min(3, remainingCapacity()));

      if (serviceUrls.length > 0) {
        console.log("[crawl] services child plan", { urls: serviceUrls });
        await fetchUrlBatch(serviceUrls);
        pages.forEach((page) => crawledUrlSet.add(canonicalizeUrl(page.url)));
      }
    }
  }

  const blogListingPage = pages.find((page) =>
    matchesPageType(
      { url: page.url, anchorText: page.title.toLowerCase() },
      "blog",
    ),
  );

  if (!usedCloudflareSeedCrawl && blogListingPage && remainingCapacity() > 0) {
    const blogArtifact = artifacts.get(canonicalizeUrl(blogListingPage.url));
    if (blogArtifact) {
      const blogPostUrl = extractSameDomainLinks(
        blogArtifact.html,
        blogListingPage.url,
      )
        .filter(
          (candidate) => !crawledUrlSet.has(canonicalizeUrl(candidate.url)),
        )
        .filter(
          (candidate) => !failedUrlSet.has(canonicalizeUrl(candidate.url)),
        )
        .find((candidate) =>
          isLikelyBlogPost(blogListingPage.url, candidate),
        )?.url;

      if (blogPostUrl) {
        console.log("[crawl] blog sample plan", { url: blogPostUrl });
        await fetchUrlBatch([blogPostUrl]);
      }
    }
  }

  if (pages.length < MAX_PAGES) {
    const extraUrls = fillUrls
      .filter((url) => !pageUrlSet.has(canonicalizeUrl(url)))
      .filter((url) => !failedUrlSet.has(canonicalizeUrl(url)))
      .filter((url) => !cloudflareSeededCanonicalUrls.has(canonicalizeUrl(url)))
      .slice(0, MAX_PAGES - pages.length);

    if (usedCloudflareSeedCrawl) {
      console.log("[crawl] skipping fill plan after Cloudflare seed crawl", {
        pagesCrawled: pages.length,
      });
    } else if (extraUrls.length > 0) {
      console.log("[crawl] fill plan", { count: extraUrls.length });
      await fetchUrlBatch(extraUrls);
    }
  }

  console.log("[crawl] completed", {
    baseUrl,
    pagesCrawled: pages.length,
    errors: errors.length,
  });

  return {
    pages: pages.slice(0, MAX_PAGES),
    errors,
  };
}
