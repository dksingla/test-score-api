import type { ClaudeScore } from "./claude";
import type { Layer1Signals } from "./layer1";
import type { PageData, RobotsMeta } from "./types";

function layer1Reason(
  score: number,
  reasoning: string,
  evidenceStatus: "verified" | "unknown" = "verified",
): ClaudeScore {
  return { score, reasoning, evidence_status: evidenceStatus };
}

function resolveHomepage(pages: PageData[]): PageData | undefined {
  return (
    pages.find((page) => {
      try {
        return new URL(page.url).pathname === "/";
      } catch {
        return false;
      }
    }) ?? pages[0]
  );
}

export function calcQ2(
  pages: PageData[],
  robots: RobotsMeta,
  layer1?: Layer1Signals,
): ClaudeScore {
  const homepage = resolveHomepage(pages);
  const pageSpeedScore = layer1?.performance.pageSpeedScore ?? null;
  const mobileFriendly = layer1?.performance.mobileFriendly ?? null;
  const homepageMetaDescription = homepage?.metaDescription?.trim() ?? "";
  const allPagesHaveTitles =
    pages.length > 0 && pages.every((page) => page.title.trim().length > 0);
  const faqSchema =
    layer1?.technical.schemaTypes.faq ??
    pages.some((page) => page.schemaSignals.faq);
  const productOrServiceSchema =
    layer1?.technical.schemaTypes.productOrService ??
    pages.some((page) => page.schemaSignals.productOrService);
  const hasSitemap = layer1?.hasSitemap ?? false;
  const aiBotsAllowed =
    (layer1?.robots.gptBotAllowed ?? robots.gptBotAllowed) === true &&
    (layer1?.robots.claudeBotAllowed ?? robots.claudeBotAllowed) === true &&
    (layer1?.robots.perplexityBotAllowed ?? robots.perplexityBotAllowed) ===
      true;

  const passed: string[] = [];
  let earned = 0;

  if (typeof pageSpeedScore === "number" && pageSpeedScore >= 70) {
    earned += 1;
    passed.push(`PageSpeed mobile ${pageSpeedScore}`);
  } else if (typeof pageSpeedScore === "number" && pageSpeedScore >= 50) {
    earned += 1;
    passed.push(`PageSpeed mobile ${pageSpeedScore}`);
  }

  if (mobileFriendly === true) {
    earned += 1;
    passed.push("mobile-friendly viewport detected");
  }

  if (homepageMetaDescription.length > 0) {
    earned += 1;
    passed.push("homepage meta description present");
  }

  if (allPagesHaveTitles) {
    earned += 1;
    passed.push("title tags present on all crawled pages");
  }

  if (faqSchema) {
    earned += 1;
    passed.push("FAQ schema detected");
  }

  if (productOrServiceSchema) {
    earned += 1;
    passed.push("Product/Service schema detected");
  }

  if (hasSitemap) {
    earned += 1;
    passed.push("sitemap detected");
  }

  if (aiBotsAllowed) {
    earned += 1;
    passed.push("GPTBot, ClaudeBot, and PerplexityBot allowed");
  }

  const score = earned >= 7 ? 2 : earned >= 4 ? 1 : 0;
  const reasoning =
    passed.length > 0
      ? `${earned}/9 technical sub-signals passed: ${passed.join("; ")}`
      : "0/9 technical sub-signals passed.";

  const hasUnavailableEvidence =
    typeof pageSpeedScore !== "number" ||
    typeof mobileFriendly !== "boolean" ||
    [robots.gptBotAllowed, robots.claudeBotAllowed, robots.perplexityBotAllowed]
      .some((value) => value === null);

  if (hasUnavailableEvidence) {
    return layer1Reason(
      1,
      `Technical checks were incomplete; verified passes: ${passed.join("; ") || "none"}.`,
      "unknown",
    );
  }

  return layer1Reason(score, reasoning);
}

export function calcQ3(pages: PageData[]): ClaudeScore {
  const homepage = resolveHomepage(pages);
  if (!homepage) {
    return layer1Reason(
      1,
      "Analytics setup could not be verified because homepage data was unavailable.",
      "unknown",
    );
  }

  if (homepage.ga4Id) {
    return layer1Reason(2, `GA4 tracking detected via ${homepage.ga4Id}.`);
  }

  if (homepage.googleTagId) {
    return layer1Reason(
      2,
      `Google tag detected via ${homepage.googleTagId}.`,
    );
  }

  if (homepage.gtmId) {
    return layer1Reason(2, `GTM container detected via ${homepage.gtmId}.`);
  }

  return layer1Reason(
    1,
    "Analytics setup could not be verified from the captured homepage markup.",
    "unknown",
  );
}

export function calcQ17(
  pages: PageData[],
  layer1?: Layer1Signals,
): ClaudeScore {
  const links =
    layer1?.technical.socialProfiles ??
    pages.reduce(
      (acc, page) => ({
        linkedin: [...acc.linkedin, ...page.socialProfiles.linkedin],
        facebook: [...acc.facebook, ...page.socialProfiles.facebook],
        instagram: [...acc.instagram, ...page.socialProfiles.instagram],
        x: [...acc.x, ...page.socialProfiles.x],
        youtube: [...acc.youtube, ...page.socialProfiles.youtube],
        tiktok: [...acc.tiktok, ...page.socialProfiles.tiktok],
        pinterest: [...acc.pinterest, ...page.socialProfiles.pinterest],
      }),
      {
        linkedin: [] as string[],
        facebook: [] as string[],
        instagram: [] as string[],
        x: [] as string[],
        youtube: [] as string[],
        tiktok: [] as string[],
        pinterest: [] as string[],
      },
    );

  const count = new Set([
    ...links.linkedin,
    ...links.facebook,
    ...links.instagram,
    ...links.x,
    ...links.youtube,
    ...links.tiktok,
    ...links.pinterest,
  ]).size;

  if (count >= 3) {
    return layer1Reason(2, `${count} social profile links detected.`);
  }

  if (count >= 1) {
    return layer1Reason(1, `${count} social profile links detected.`);
  }

  return layer1Reason(
    1,
    "Social profiles could not be verified from the crawled pages.",
    "unknown",
  );
}

export function calcQ18(
  pages: PageData[],
  layer1?: Layer1Signals,
): ClaudeScore {
  const latest =
    layer1?.technical.latestDateModified ??
    pages
      .map((page) => page.dateModified)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ??
    null;

  if (!latest) {
    return layer1Reason(
      1,
      "Content freshness could not be verified because no reliable dates were captured.",
      "unknown",
    );
  }

  const ageMs = Date.now() - Date.parse(latest);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);

  if (ageDays <= 90) {
    return layer1Reason(2, `Most recent detectable update was ${latest}.`);
  }

  if (ageDays <= 365) {
    return layer1Reason(1, `Most recent detectable update was ${latest}.`);
  }

  return layer1Reason(0, `Most recent detectable update was ${latest}.`);
}
