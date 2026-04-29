import * as cheerio from "cheerio";
import axios from "axios";
import { parseHTML } from "./parser";
import {
  buildCloudflareExcludePatterns,
  buildCloudflareIncludePatterns,
  PAGE_TYPE_RULES,
} from "./pageSelectionRules";
import type { CrawlError, PageData } from "./types";

const BASE = "https://api.cloudflare.com/client/v4/accounts";

type CfJobStatus =
  | "running"
  | "cancelled_due_to_timeout"
  | "cancelled_due_to_limits"
  | "cancelled_by_user"
  | "errored"
  | "completed";

interface CfStartResponse {
  success: boolean;
  result?: string;
  errors?: unknown;
  messages?: unknown;
}

interface CfRecord {
  url: string;
  status: string;
  html?: string;
  markdown?: string;
  metadata?: unknown;
}

interface CfJobResult {
  id: string;
  status: CfJobStatus;
  total?: number;
  finished?: number;
  records?: CfRecord[];
  cursor?: number;
}

interface CfJobResponse {
  success: boolean;
  result?: CfJobResult;
  errors?: unknown;
  messages?: unknown;
}

interface CfContentOptions {
  gotoOptions?: {
    timeout?: number;
    waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
  };
  rejectResourceTypes?: string[];
  rejectRequestPattern?: string[];
  setExtraHTTPHeaders?: Record<string, string>;
  userAgent?: string;
}

interface CfWrappedContentResponse {
  success?: boolean;
  result?:
    | string
    | {
        html?: string;
        content?: string;
        data?: string;
      };
  html?: string;
  content?: string;
  data?: string;
}

const CHALLENGE_MARKERS = [
  "<title>just a moment",
  "challenges.cloudflare.com",
  "cf_chl_opt",
  "enable javascript and cookies to continue",
  "performing security verification",
  "verification successful. waiting for",
  "this website uses a security service to protect against malicious bots",
  "performance and security by cloudflare",
  "ray id:",
] as const;

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} is not set`);
  return v.trim();
}

function bearerHeaders(): Record<string, string> {
  // Cloudflare requires a token with Browser Rendering - Edit permission.
  const token = mustEnv("CLOUDFLARE_API_TOKEN");
  return { Authorization: `Bearer ${token}` };
}

function accountId(): string {
  return mustEnv("CLOUDFLARE_ACCOUNT_ID");
}

const CLOUDFLARE_HTTP_TIMEOUT_MS = 60_000;
const CLOUDFLARE_JOB_MAX_WAIT_MS = 4 * 60 * 1000;
const BROWSER_RUN_QUICK_ACTION_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
const CLOUDFLARE_CONTENT_MAX_PAGES = 15;
const CLOUDFLARE_CONTENT_FETCH_CONCURRENCY = 1;
const CLOUDFLARE_CONTENT_BATCH_DELAY_MS = 15_000;
const CLOUDFLARE_CONTENT_RATE_LIMIT_RETRIES = 3;
let cloudflareContentCooldownUntil = 0;

function formatAxiosError(err: unknown): Record<string, unknown> {
  if (!axios.isAxiosError(err)) {
    return {
      message: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    status: err.response?.status ?? null,
    statusText: err.response?.statusText ?? null,
    data: err.response?.data ?? null,
    headers: err.response?.headers ?? null,
    code: err.code ?? null,
    message: err.message,
  };
}

function previewUnknownData(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").slice(0, 300);
  }

  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value).slice(0, 500);
    } catch {
      return Object.keys(value as Record<string, unknown>);
    }
  }

  return value;
}

function extractMetadataLastModified(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).lastModified;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRetryAfterMs(headers: Record<string, unknown>): number {
  const retryAfter = headers["retry-after"];
  const raw =
    typeof retryAfter === "string"
      ? retryAfter
      : Array.isArray(retryAfter) && typeof retryAfter[0] === "string"
        ? retryAfter[0]
        : null;

  if (!raw) return 10_000;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return 10_000;
}

export function isCloudflareChallengeHtml(html: string): boolean {
  const normalized = html.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => normalized.includes(marker));
}

interface CloudflareLinkCandidate {
  url: string;
  anchorText: string;
  isNav: boolean;
  order: number;
}

export interface CloudflareRankedCandidate {
  url: string;
  anchorText: string;
  isNav: boolean;
  priorityType: keyof typeof PAGE_TYPE_RULES | null;
  score: number;
}

export interface CloudflareContentBatchResult {
  pages: PageData[];
  errors: CrawlError[];
  homepageError: CrawlError | null;
  topCandidates: CloudflareRankedCandidate[];
  fetchPlan: {
    homepageIncluded: boolean;
    candidateUrls: string[];
    concurrency: number;
    batchDelayMs: number;
    retriesOnRateLimit: number;
  };
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

function extractSameDomainLinks(
  html: string,
  baseUrl: string,
): CloudflareLinkCandidate[] {
  const baseHost = new URL(baseUrl).hostname.replace(/^www\./, "");
  const seen = new Set<string>();
  const links: CloudflareLinkCandidate[] = [];
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

function matchesNavText(text: string, values: readonly string[]): boolean {
  return values.some((value) => text === value || text.includes(value));
}

function matchesSlug(pathname: string, values: readonly string[]): boolean {
  return values.some(
    (value) => pathname === value || pathname.startsWith(`${value}/`),
  );
}

function detectPriorityType(
  candidate: CloudflareLinkCandidate,
): keyof typeof PAGE_TYPE_RULES | null {
  let pathname = "";

  try {
    pathname = new URL(candidate.url).pathname.toLowerCase().replace(/\/$/, "");
  } catch {
    return null;
  }

  for (const [type, rule] of Object.entries(PAGE_TYPE_RULES) as Array<
    [
      keyof typeof PAGE_TYPE_RULES,
      (typeof PAGE_TYPE_RULES)[keyof typeof PAGE_TYPE_RULES],
    ]
  >) {
    if (
      matchesNavText(candidate.anchorText, rule.navTexts) ||
      matchesSlug(pathname, rule.slugs)
    ) {
      return type;
    }
  }

  return null;
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

function rankCandidate(candidate: CloudflareLinkCandidate): number {
  let score = scoreLink(candidate.url);

  if (candidate.isNav) score += 50;
  if (candidate.anchorText.length > 0) score += 10;
  score += Math.max(0, 20 - candidate.order);
  if (detectPriorityType(candidate)) score += 120;

  return score;
}

function selectTopCandidates(
  html: string,
  baseUrl: string,
): CloudflareRankedCandidate[] {
  const candidates = extractSameDomainLinks(html, baseUrl);
  const seen = new Set<string>();

  return candidates
    .sort((a, b) => rankCandidate(b) - rankCandidate(a))
    .filter((candidate) => {
      try {
        const parsed = new URL(candidate.url);
        if (parsed.searchParams.has("page_id")) return false;
        return true;
      } catch {
        return false;
      }
    })
    .filter((candidate) => {
      const canonical = canonicalizeUrl(candidate.url);
      if (seen.has(canonical)) return false;
      seen.add(canonical);
      return true;
    })
    .slice(0, CLOUDFLARE_CONTENT_MAX_PAGES)
    .map((candidate) => ({
      url: candidate.url,
      anchorText: candidate.anchorText,
      isNav: candidate.isNav,
      priorityType: detectPriorityType(candidate),
      score: rankCandidate(candidate),
    }));
}

async function withConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const index = cursor++;
      try {
        results[index] = {
          status: "fulfilled",
          value: await tasks[index](),
        };
      } catch (err) {
        results[index] = {
          status: "rejected",
          reason: err,
        };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, () => worker()),
  );

  return results;
}

function isRateLimitedError(error: CrawlError): boolean {
  return error.message.toLowerCase().includes("rate limited");
}

async function startCrawl(
  url: string,
  signal: AbortSignal,
  options?: { limit?: number; depth?: number },
): Promise<string> {
  const endpoint = `${BASE}/${accountId()}/browser-rendering/crawl`;
  const includePatterns = buildCloudflareIncludePatterns(url);
  const excludePatterns = buildCloudflareExcludePatterns(url);
  try {
    const { data } = await axios.post<CfStartResponse>(
      endpoint,
      {
        crawlPurposes: ["search"],
        url,
        limit: options?.limit ?? 15,
        depth: options?.depth ?? 2,
        formats: ["html"],
        render: true,
        source: "all",
        gotoOptions: {
          timeout: 45_000,
          waitUntil: "networkidle2",
        },
        rejectResourceTypes: ["image", "media", "font"],
        options: {
          includeExternalLinks: false,
          includeSubdomains: true,
          includePatterns,
          excludePatterns,
        },
      },
      {
        headers: { ...bearerHeaders(), "Content-Type": "application/json" },
        timeout: CLOUDFLARE_HTTP_TIMEOUT_MS,
        signal,
      },
    );
    if (!data?.success || !data.result) {
      throw new Error("Cloudflare crawl start failed: missing result id");
    }
    return data.result;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error("[cloudflare-crawl] start failed:", {
        endpoint,
        ...formatAxiosError(err),
      });
    } else {
      console.error(
        "[cloudflare-crawl] start failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  }
}

export async function fetchCloudflareRenderedHtml(
  url: string,
  signal: AbortSignal,
  options?: CfContentOptions,
): Promise<string | null> {
  if (!process.env.CLOUDFLARE_API_TOKEN?.trim()) return null;
  if (!process.env.CLOUDFLARE_ACCOUNT_ID?.trim()) return null;

  const endpoint = `${BASE}/${accountId()}/browser-rendering/content`;

  try {
    const cooldownMs = cloudflareContentCooldownUntil - Date.now();
    if (cooldownMs > 0) {
      console.log("[cloudflare-content] honoring retry-after cooldown", {
        url,
        waitMs: cooldownMs,
      });
      await delayMs(cooldownMs);
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, headers } = await axios.post<
        string | CfWrappedContentResponse
      >(
        endpoint,
        {
          url,
          userAgent:
            options?.userAgent ?? BROWSER_RUN_QUICK_ACTION_USER_AGENT,
          gotoOptions: {
            timeout: 45_000,
            waitUntil: "networkidle2",
            ...options?.gotoOptions,
          },
          rejectResourceTypes: options?.rejectResourceTypes ?? [
            "image",
            "media",
            "font",
          ],
          rejectRequestPattern: options?.rejectRequestPattern ?? [
            "/^.*\\.(css)$/i",
          ],
          setExtraHTTPHeaders: options?.setExtraHTTPHeaders,
        },
        {
          headers: {
            ...bearerHeaders(),
            "Content-Type": "application/json",
          },
          timeout: CLOUDFLARE_HTTP_TIMEOUT_MS,
          signal,
        },
      );

      const contentType =
        typeof headers["content-type"] === "string"
          ? headers["content-type"].toLowerCase()
          : "";

      const html =
        typeof data === "string"
          ? data
          : typeof data?.result === "string"
            ? data.result
            : (data?.result?.html ??
              data?.result?.content ??
              data?.result?.data ??
              data?.html ??
              data?.content ??
              data?.data ??
              null);

      console.log("[cloudflare-content] response received", {
        url,
        attempt: attempt + 1,
        contentType,
        responseShape:
          typeof data === "string"
            ? "string"
            : data && typeof data === "object"
              ? Object.keys(data)
              : typeof data,
        resultShape:
          data &&
          typeof data === "object" &&
          "result" in data &&
          data.result &&
          typeof data.result === "object"
            ? Object.keys(data.result)
            : null,
        payloadPreview: previewUnknownData(data),
        extractedHtmlLength: typeof html === "string" ? html.length : null,
        extractedHtmlPreview:
          typeof html === "string"
            ? html.replace(/\s+/g, " ").slice(0, 200)
            : null,
      });

      if (typeof html !== "string" || !html.trim()) {
        console.warn("[cloudflare-content] empty response", {
          url,
          contentType,
          responseShape:
            typeof data === "string"
              ? "string"
              : data && typeof data === "object"
                ? Object.keys(data)
                : typeof data,
        });
        throw new Error("Cloudflare content returned no HTML");
      }

      if (isCloudflareChallengeHtml(html)) {
        console.warn("[cloudflare-content] challenge page returned", {
          url,
          attempt: attempt + 1,
          contentType,
          htmlPreview: html.replace(/\s+/g, " ").slice(0, 200),
        });
        if (attempt < 3) {
          await delayMs(4_000);
          continue;
        }
        throw new Error("Cloudflare content returned challenge page");
      }

      console.log("[cloudflare-content] rendered HTML fetched", {
        url,
        contentType,
        htmlLength: html.length,
      });
      return html;
    }

    throw new Error("Cloudflare content returned challenge page");
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 429) {
      const waitMs = extractRetryAfterMs(
        (err.response?.headers ?? {}) as Record<string, unknown>,
      );
      cloudflareContentCooldownUntil = Date.now() + waitMs;
      console.warn("[cloudflare-content] rate limited", {
        url,
        waitMs,
      });
      throw new Error("Cloudflare content rate limited");
    }

    console.error("[cloudflare-content] request failed", {
      endpoint,
      url,
      ...formatAxiosError(err),
    });
    throw err;
  }
}

async function fetchCloudflarePages(
  startUrl: string,
  signal: AbortSignal,
  options?: { limit?: number; depth?: number; maxPages?: number },
): Promise<PageData[]> {
  if (!process.env.CLOUDFLARE_API_TOKEN?.trim()) return [];
  if (!process.env.CLOUDFLARE_ACCOUNT_ID?.trim()) return [];

  try {
    const jobId = await startCrawl(startUrl, signal, options);
    console.log("[cloudflare-crawl] job started", {
      jobId,
      startUrl,
      limit: options?.limit ?? 3,
      depth: options?.depth ?? 1,
    });
    const { job, timedOut } = await waitForCompletion(jobId, signal);
    if (timedOut) {
      const partial = await parsePagesFromRecords(
        job.records ?? [],
        signal,
        options?.maxPages ?? 12,
      );
      return partial.pages;
    }

    if (job.status !== "completed") {
      return [];
    }

    const records = await fetchAllRecords(jobId, signal);
    const parsed = await parsePagesFromRecords(
      records,
      signal,
      options?.maxPages ?? 12,
    );
    return parsed.pages;
  } catch (err) {
    console.error(
      "[cloudflare-crawl]",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

async function getJob(
  jobId: string,
  signal: AbortSignal,
  limit?: number,
  cursor?: number,
): Promise<CfJobResult> {
  const endpoint = `${BASE}/${accountId()}/browser-rendering/crawl/${encodeURIComponent(jobId)}`;
  const params: Record<string, string> = {};
  if (limit !== undefined) params.limit = String(limit);
  if (cursor !== undefined) params.cursor = String(cursor);

  const { data } = await axios.get<CfJobResponse>(endpoint, {
    headers: bearerHeaders(),
    params,
    timeout: CLOUDFLARE_HTTP_TIMEOUT_MS,
    signal,
  });

  if (!data?.success || !data.result) {
    throw new Error("Cloudflare crawl job fetch failed");
  }
  return data.result;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("Aborted");
  await new Promise<void>((resolve, reject) => {
    let t: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort);
    t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
  });
}

async function waitForCompletion(
  jobId: string,
  signal: AbortSignal,
): Promise<{ job: CfJobResult; timedOut: boolean }> {
  const startedAt = Date.now();

  while (true) {
    const job = await getJob(jobId, signal, 25);
    if (job.status !== "running") {
      return { job, timedOut: false };
    }

    if (Date.now() - startedAt >= CLOUDFLARE_JOB_MAX_WAIT_MS) {
      console.warn("[cloudflare-crawl] max wait reached, using latest job response", {
        jobId,
        waitedMs: Date.now() - startedAt,
        finished: job.finished ?? null,
        total: job.total ?? null,
      });
      return { job, timedOut: true };
    }

    await sleep(2500, signal);
  }
}

async function fetchAllRecords(
  jobId: string,
  signal: AbortSignal,
): Promise<CfRecord[]> {
  const records: CfRecord[] = [];
  let cursor: number | undefined = undefined;

  while (true) {
    const job = await getJob(jobId, signal, 25, cursor);
    const batch = job.records ?? [];
    records.push(...batch);

    if (job.cursor === undefined || job.cursor === cursor) break;
    cursor = job.cursor;
    if (records.length >= 60) break; // hard cap for payload/time safety
  }

  return records;
}

function classifyCloudflareRecord(record: CfRecord): CrawlError | null {
  if (record.status === "completed") {
    if (typeof record.html === "string" && isCloudflareChallengeHtml(record.html)) {
      return {
        url: record.url,
        type: "blocked",
        message: "Cloudflare crawl returned verification page",
      };
    }
    return null;
  }

  const metadata =
    record.metadata && typeof record.metadata === "object"
      ? (record.metadata as Record<string, unknown>)
      : {};
  const statusCode =
    typeof metadata.status === "number" ? metadata.status : undefined;
  const bodyPreview =
    typeof record.html === "string"
      ? record.html.replace(/\s+/g, " ").slice(0, 200)
      : typeof record.markdown === "string"
        ? record.markdown.replace(/\s+/g, " ").slice(0, 200)
        : "";

  return {
    url: record.url,
    type:
      statusCode === 401 || statusCode === 403 || statusCode === 429
        ? "blocked"
        : record.status === "disallowed"
          ? "blocked"
          : record.status === "errored"
            ? "server_error"
            : "unknown",
    message:
      statusCode !== undefined
        ? `Cloudflare crawl record status ${statusCode}`
        : bodyPreview || `Cloudflare crawl record status ${record.status}`,
  };
}

async function parsePagesFromRecords(
  records: CfRecord[],
  signal: AbortSignal,
  maxPages: number,
): Promise<{ pages: PageData[]; errors: CrawlError[] }> {
  const pages: PageData[] = [];
  const errors: CrawlError[] = [];

  for (const record of records) {
    if (record.status === "completed") {
      let html = typeof record.html === "string" ? record.html : "";
      const markdown =
        typeof record.markdown === "string" ? record.markdown : "";

      if (html && isCloudflareChallengeHtml(html)) {
        try {
          const resolvedHtml = await fetchCloudflareRenderedHtml(record.url, signal, {
            gotoOptions: {
              timeout: 45_000,
              waitUntil: "networkidle2",
            },
          });
          html = resolvedHtml ?? html;
        } catch (err) {
          errors.push({
            url: record.url,
            type: "blocked",
            message:
              err instanceof Error
                ? err.message
                : "Cloudflare content fetch failed after verification page",
          });
          continue;
        }
      }

      const content = html || markdown;
      if (html && isCloudflareChallengeHtml(html)) {
        errors.push({
          url: record.url,
          type: "blocked",
          message: "Cloudflare crawl returned verification page",
        });
        continue;
      }
      if (!content.trim()) continue;
      pages.push(
        parseHTML(content, record.url, {
          httpLastModified: extractMetadataLastModified(record.metadata),
        }),
      );
      if (pages.length >= maxPages) break;
      continue;
    }

    const error = classifyCloudflareRecord(record);
    if (error) errors.push(error);
  }

  return { pages, errors };
}

/**
 * Cloudflare Browser Rendering crawl fallback.
 * Returns [] when creds are missing.
 */
export async function fetchCloudflareCrawlPages(
  startUrl: string,
  signal: AbortSignal,
): Promise<PageData[]> {
  const result = await fetchCloudflareContentBatchResult(startUrl, signal);
  return result.pages;
}

export async function fetchCloudflareCrawlResult(
  startUrl: string,
  signal: AbortSignal,
): Promise<{ pages: PageData[]; errors: CrawlError[] }> {
  if (!process.env.CLOUDFLARE_API_TOKEN?.trim()) {
    return { pages: [], errors: [] };
  }
  if (!process.env.CLOUDFLARE_ACCOUNT_ID?.trim()) {
    return { pages: [], errors: [] };
  }

  try {
    const result = await fetchCloudflareContentBatchResult(startUrl, signal);

    console.log("[cloudflare-content] protected-site batch completed", {
      startUrl,
      pages: result.pages.length,
      errors: result.errors.length,
      homepageIncluded: result.fetchPlan.homepageIncluded,
      candidateUrls: result.fetchPlan.candidateUrls.length,
    });

    return {
      pages: result.pages,
      errors: result.errors,
    };
  } catch (err) {
    console.error(
      "[cloudflare-content] protected-site batch failed",
      err instanceof Error ? err.message : String(err),
    );
    return {
      pages: [],
      errors: [
        {
          url: startUrl,
          type: "unknown",
          message:
            err instanceof Error ? err.message : "Cloudflare crawl failed",
        },
      ],
    };
  }
}

export async function fetchCloudflarePage(
  url: string,
  signal: AbortSignal,
  _budgetMs: number,
): Promise<PageData | null> {
  const html = await fetchCloudflareRenderedHtml(url, signal);
  return html ? parseHTML(html, url) : null;
}

export async function fetchCloudflareContentResult(
  url: string,
  signal: AbortSignal,
): Promise<{ html: string | null; page: PageData | null; error: CrawlError | null }> {
  try {
    const html = await fetchCloudflareRenderedHtml(url, signal, {
      gotoOptions: {
        timeout: 45_000,
        waitUntil: "networkidle2",
      },
      rejectResourceTypes: ["image", "media", "font"],
      rejectRequestPattern: ["/^.*\\.(css)$/i"],
    });

    if (!html) {
      return {
        html: null,
        page: null,
        error: {
          url,
          type: "unknown",
          message: "Cloudflare content returned no HTML",
        },
      };
    }

    return {
      html,
      page: parseHTML(html, url),
      error: null,
    };
  } catch (err) {
    return {
      html: null,
      page: null,
      error: {
        url,
        type: "blocked",
        message:
          err instanceof Error
            ? err.message
            : "Cloudflare content request failed",
      },
    };
  }
}

async function fetchCandidateWithRetries(
  candidateUrl: string,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof fetchCloudflareContentResult>>> {
  let lastResult: Awaited<ReturnType<typeof fetchCloudflareContentResult>> | null =
    null;

  for (
    let attempt = 0;
    attempt <= CLOUDFLARE_CONTENT_RATE_LIMIT_RETRIES;
    attempt++
  ) {
    const result = await fetchCloudflareContentResult(candidateUrl, signal);
    lastResult = result;

    if (!result.error || !isRateLimitedError(result.error)) {
      return result;
    }

    if (attempt < CLOUDFLARE_CONTENT_RATE_LIMIT_RETRIES) {
      await delayMs(CLOUDFLARE_CONTENT_BATCH_DELAY_MS * (attempt + 1));
    }
  }

  return (
    lastResult ?? {
      html: null,
      page: null,
      error: {
        url: candidateUrl,
        type: "blocked",
        message: "Cloudflare content rate limited",
      },
    }
  );
}

export async function fetchCloudflareContentBatchResult(
  startUrl: string,
  signal: AbortSignal,
): Promise<CloudflareContentBatchResult> {
  const homepageResult = await fetchCloudflareContentResult(startUrl, signal);
  const homepageCanonical = canonicalizeUrl(startUrl);
  const rankedCandidates = homepageResult.html
    ? selectTopCandidates(homepageResult.html, startUrl)
    : [];
  const candidatePlan = rankedCandidates
    .filter((candidate) => canonicalizeUrl(candidate.url) !== homepageCanonical)
    .slice(0, CLOUDFLARE_CONTENT_MAX_PAGES - 1);

  const pages = homepageResult.page ? [homepageResult.page] : [];
  const errors = homepageResult.error ? [homepageResult.error] : [];

  for (
    let i = 0;
    i < candidatePlan.length;
    i += CLOUDFLARE_CONTENT_FETCH_CONCURRENCY
  ) {
    const batch = candidatePlan.slice(
      i,
      i + CLOUDFLARE_CONTENT_FETCH_CONCURRENCY,
    );
    const settledPages = await withConcurrency(
      batch.map((candidate) => async () => ({
        candidate,
        result: await fetchCandidateWithRetries(candidate.url, signal),
      })),
      CLOUDFLARE_CONTENT_FETCH_CONCURRENCY,
    );

    for (const settled of settledPages) {
      if (settled.status !== "fulfilled") {
        errors.push({
          url: startUrl,
          type: "unknown",
          message:
            settled.reason instanceof Error
              ? settled.reason.message
              : "Cloudflare content request failed",
        });
        continue;
      }

      const { candidate, result } = settled.value;
      if (result.page) {
        const canonical = canonicalizeUrl(result.page.url);
        if (!pages.some((page) => canonicalizeUrl(page.url) === canonical)) {
          pages.push(result.page);
        }
      }

      if (result.error) {
        errors.push({
          ...result.error,
          url: candidate.url,
        });
      }
    }

    if (i + CLOUDFLARE_CONTENT_FETCH_CONCURRENCY < candidatePlan.length) {
      await delayMs(CLOUDFLARE_CONTENT_BATCH_DELAY_MS);
    }
  }

  return {
    pages: pages.slice(0, CLOUDFLARE_CONTENT_MAX_PAGES),
    errors,
    homepageError: homepageResult.error,
    topCandidates: candidatePlan,
    fetchPlan: {
      homepageIncluded: Boolean(homepageResult.page),
      candidateUrls: candidatePlan.map((candidate) => candidate.url),
      concurrency: CLOUDFLARE_CONTENT_FETCH_CONCURRENCY,
      batchDelayMs: CLOUDFLARE_CONTENT_BATCH_DELAY_MS,
      retriesOnRateLimit: CLOUDFLARE_CONTENT_RATE_LIMIT_RETRIES,
    },
  };
}
