import type {
  ClaudeFailureResponse,
  ClaudeResponse,
  ClaudeScore,
  ClaudeSuccessResponse,
  PriorityFix,
} from "./claude";
import type { Layer1Signals } from "./layer1";
import type { PageData, RobotsMeta } from "./types";

interface FinalScore {
  score: number;
  tier: string;
  pillars: Record<string, number>;
  answers: Record<string, number>;
  scores: Record<string, ClaudeScore>;
  businessName: string;
  businessDescription: string;
  confidence: "high" | "medium" | "low";
  priorityFixes: PriorityFix[];
}

const PILLARS: Record<string, string[]> = {
  foundation: ["q2", "q3"],
  intent: ["q1", "q13"],
  relevance: ["q4", "q5", "q6"],
  expertise: ["q7", "q8", "q9", "q16"],
  unify: ["q11", "q17"],
  performance: ["q14", "q15", "q18"],
};

const WEIGHTS: Record<string, number> = {
  foundation: 0.2,
  intent: 0.15,
  relevance: 0.2,
  expertise: 0.2,
  unify: 0.15,
  performance: 0.1,
};

function layer1Reason(score: number, reasoning: string): ClaudeScore {
  return { score, reasoning };
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

function calcQ2(
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
    (layer1?.robots.gptBotAllowed ?? robots.gptBotAllowed) !== false &&
    (layer1?.robots.claudeBotAllowed ?? robots.claudeBotAllowed) !== false &&
    (layer1?.robots.perplexityBotAllowed ?? robots.perplexityBotAllowed) !== false;

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

  return layer1Reason(score, reasoning);
}

function calcQ3(pages: PageData[]): ClaudeScore {
  const homepage = resolveHomepage(pages);
  if (!homepage) {
    return layer1Reason(0, "No homepage data available.");
  }

  if (homepage.ga4Id) {
    return layer1Reason(2, `GA4 tracking detected via ${homepage.ga4Id}.`);
  }

  if (homepage.gtmId) {
    return layer1Reason(2, `GTM container detected via ${homepage.gtmId}.`);
  }

  return layer1Reason(0, "No GA4 or GTM container detected.");
}

function calcQ17(
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

  return layer1Reason(0, "No social profile links detected.");
}

function calcQ18(
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
    return layer1Reason(0, "No detectable modified dates found.");
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

function calcPillar(questions: string[], scores: Record<string, ClaudeScore>): number {
  const earned = questions.reduce((sum, question) => {
    return sum + (scores[question]?.score ?? 0);
  }, 0);

  return (earned / (questions.length * 2)) * 100;
}

function getTier(score: number): string {
  if (score <= 39) return "Hidden";
  if (score <= 69) return "Emerging";
  if (score <= 84) return "AI-Ready";
  return "AI-Optimized";
}

function calcConfidence(
  pages: PageData[],
  robots: RobotsMeta,
  errorCount: number,
): "high" | "medium" | "low" {
  let points = 0;

  if (pages.length >= 5) points += 3;
  else if (pages.length >= 3) points += 2;
  else points += 1;

  if (errorCount >= 3) points -= 2;
  else if (errorCount >= 1) points -= 1;

  if (pages[0]?.isJSSite) points -= 1;

  if (
    robots.gptBotAllowed === false ||
    robots.claudeBotAllowed === false ||
    robots.perplexityBotAllowed === false
  ) {
    points -= 1;
  }

  if (points >= 3) return "high";
  if (points >= 2) return "medium";
  return "low";
}

function isClaudeFailure(response: ClaudeResponse): response is ClaudeFailureResponse {
  return "error" in response;
}

function isClaudeSuccess(response: ClaudeResponse): response is ClaudeSuccessResponse {
  return !isClaudeFailure(response);
}

export function calculateScore(
  aiResponse: ClaudeResponse,
  pages: PageData[],
  robots: RobotsMeta,
  errorCount: number = 0,
  layer1?: Layer1Signals,
): FinalScore {
  if (!isClaudeSuccess(aiResponse)) {
    throw new Error(aiResponse.message);
  }

  const allScores: Record<string, ClaudeScore> = {
    ...aiResponse.scores,
    q2: calcQ2(pages, robots, layer1),
    q3: calcQ3(pages),
    q17: calcQ17(pages, layer1),
    q18: calcQ18(pages, layer1),
  };

  const pillarValues: Record<string, number> = {};
  for (const [pillar, questions] of Object.entries(PILLARS)) {
    pillarValues[pillar] = calcPillar(questions, allScores);
  }

  const total = Object.entries(WEIGHTS).reduce((sum, [pillar, weight]) => {
    return sum + (pillarValues[pillar] ?? 0) * weight;
  }, 0);

  const score = Math.round(total);
  const pillars = Object.fromEntries(
    Object.entries(pillarValues).map(([pillar, value]) => [pillar, Math.round(value)]),
  );

  const answers: Record<string, number> = {};
  for (const [question, result] of Object.entries(allScores)) {
    answers[question] = result.score;
  }

  const homepage = resolveHomepage(pages);
  const rawBody = homepage?.bodyText ?? "";
  const meaningfulSnippet =
    rawBody
      .split(/[.?!]/)
      .find((sentence) => sentence.trim().length > 40)
      ?.trim() ?? "";

  return {
    score,
    tier: getTier(score),
    pillars,
    answers,
    scores: allScores,
    businessName: aiResponse.business_name || homepage?.businessName || "",
    businessDescription:
      homepage?.metaDescription || meaningfulSnippet || rawBody.slice(0, 200),
    confidence: calcConfidence(pages, robots, errorCount),
    priorityFixes: aiResponse.priority_fixes,
  };
}
