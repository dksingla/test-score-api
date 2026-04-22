import axios from "axios";
import { parseHTML } from "./parser";
import type { PageData } from "./types";

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

const CLOUDFLARE_HTTP_TIMEOUT_MS = 30_000;

async function startCrawl(url: string, signal: AbortSignal): Promise<string> {
  const endpoint = `${BASE}/${accountId()}/browser-rendering/crawl`;
  try {
    const { data } = await axios.post<CfStartResponse>(
      endpoint,
      {
        url,
        limit: 3, // ← was 12, reduce drastically
        depth: 1, // ← was 3, only crawl top level
        formats: ["html"],
        render: true,
        source: "all",
        options: {
          includeExternalLinks: false,
          includeSubdomains: false, // ← was true, disable
          // Remove includePatterns filter — let it pick the best pages
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
        status: err.response?.status,
        statusText: err.response?.statusText,
        data: err.response?.data,
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
  timeoutMs: number,
): Promise<CfJobResult | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await getJob(jobId, signal, 1);
    if (job.status !== "running") return job;
    await sleep(2500, signal);
  }
  return null;
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

/**
 * Cloudflare Browser Rendering crawl fallback.
 * Returns [] when creds are missing or job doesn't finish within budget.
 */
export async function fetchCloudflareCrawlPages(
  startUrl: string,
  signal: AbortSignal,
  budgetMs: number,
): Promise<PageData[]> {
  if (!process.env.CLOUDFLARE_API_TOKEN?.trim()) return [];
  if (!process.env.CLOUDFLARE_ACCOUNT_ID?.trim()) return [];

  try {
    const jobId = await startCrawl(startUrl, signal);
    console.log("jobId is:", jobId);
    const done = await waitForCompletion(jobId, signal, budgetMs);
    console.log("done is:", done);
    if (!done) return [];
    if (done.status !== "completed") {
      return [];
    }

    const records = await fetchAllRecords(jobId, signal);
    console.log("records is:", records);
    const pages: PageData[] = [];

    for (const r of records) {
      if (r.status !== "completed") continue;
      const html = typeof r.html === "string" ? r.html : "";
      const md = typeof r.markdown === "string" ? r.markdown : "";
      const content = html || md;
      if (!content.trim()) continue;
      pages.push(parseHTML(content, r.url));
      if (pages.length >= 12) break;
    }

    return pages;
  } catch (err) {
    console.error(
      "[cloudflare-crawl]",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}
