import { crawlPages, probeProtection } from "./crawler";

import type { CrawlResult } from "./types";

export async function hybridCrawl(
  baseUrl: string,
  signal: AbortSignal,
): Promise<CrawlResult> {
  const probe = await probeProtection(baseUrl, signal);

  if (probe.protected) {
    console.log(
      "[hybrid] homepage probe detected protection, normal-first flow will decide Cloudflare crawl",
      {
        baseUrl,
        vendor: probe.vendor,
      },
    );
  } else {
    console.log("[hybrid] homepage probe clear, using mixed fetch routing", {
      baseUrl,
    });
  }

  return crawlPages(baseUrl, signal);
}
