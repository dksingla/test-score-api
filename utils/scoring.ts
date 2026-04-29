import type { ClaudeResponse } from "./claude";
import type { PageData, RobotsMeta } from "./types";
import type { Layer1Signals } from "./layer1";

interface ClaudeScore {
  score: number;
  reason: string;
}

interface FinalScore {
  score: number;
  tier: string;
  pillars: Record<string, number>;
  answers: Record<string, number>;
  scores: ClaudeResponse; // full merged scores including Layer 1 q2/q3
  businessName: string;
  businessDescription: string;
  confidence: "high" | "medium" | "low";
}

// ─── FIREUP pillar → question mapping ────────────────────────────────────────
// q2 and q3 are Layer 1 signals calculated programmatically below.

const PILLARS: Record<string, string[]> = {
  foundation: ["q1", "q2", "q3"], // homepage clarity + technical basics + analytics
  intent: ["q4", "q5", "q6"], // content freshness, buyer Qs, structure
  relevance: ["q11"], // positioning consistency across pages
  expertise: ["q7", "q8", "q9"], // testimonials, case studies, About page
  unify: ["q10", "q12"], // brand presence, external mentions
  performance: ["q13", "q14", "q15"], // lead magnet, CTAs, follow-up
};

const WEIGHTS: Record<string, number> = {
  foundation: 0.2,
  intent: 0.15,
  relevance: 0.2,
  expertise: 0.2,
  unify: 0.15,
  performance: 0.1,
};

// ─── Layer 1: Technical signal scoring ───────────────────────────────────────

/**
 * Q2 — Technical basics: schema markup, meta description, H1 structure,
 * and AI crawler access via robots.txt.
 *
 * When pre-computed Layer 1 signals are supplied (from collectLayer1Signals)
 * those values are used directly to avoid re-reading the same page fields.
 */
function calcQ2(
  pages: PageData[],
  robots: RobotsMeta,
  layer1?: Layer1Signals,
): ClaudeScore {
  const homepage = pages[0];
  if (!homepage) {
    return { score: 0, reason: "No homepage data available" };
  }

  // Use pre-computed signals when available; fall back to reading page data
  const hasSchema = layer1
    ? layer1.technical.hasSchema
    : homepage.schemas.length > 0;
  const hasAnalytics = layer1
    ? layer1.technical.hasAnalyticsTracking
    : Boolean(homepage.ga4Id || homepage.gtmId);
  const aiAllowed = layer1
    ? layer1.robots.gptBotAllowed !== false &&
      layer1.robots.claudeBotAllowed !== false &&
      layer1.robots.perplexityBotAllowed !== false
    : robots.gptBotAllowed !== false &&
      robots.claudeBotAllowed !== false &&
      robots.perplexityBotAllowed !== false;

  const passed: string[] = [];
  let earned = 0;
  const total = 4;

  if (hasSchema) {
    earned++;
    passed.push("schema markup present");
  }
  if (hasAnalytics) {
    earned++;
    passed.push("analytics tracking present");
  }
  if (aiAllowed) {
    earned++;
    passed.push("AI crawlers allowed in robots.txt");
  }

  const score = Math.min(2, Math.round((earned / total) * 2)) as 0 | 1 | 2;
  const reason =
    passed.length > 0
      ? passed.join("; ")
      : "Missing schema, analytics tracking, and AI crawler access";

  return { score, reason };
}

/**
 * Q3 — Analytics tracking: GA4 or GTM detected in page source.
 */
function calcQ3(pages: PageData[]): ClaudeScore {
  const homepage = pages[0];
  if (!homepage) {
    return { score: 0, reason: "No homepage data available" };
  }
  if (homepage.ga4Id) {
    return { score: 2, reason: `GA4 tracking detected (${homepage.ga4Id})` };
  }
  if (homepage.gtmId) {
    return { score: 2, reason: `GTM container detected (${homepage.gtmId})` };
  }
  return { score: 0, reason: "No GA4 or GTM tracking script detected" };
}

// ─── Pillar aggregation ───────────────────────────────────────────────────────

function calcPillar(questions: string[], scores: ClaudeResponse): number {
  const max = questions.length * 2;
  let earned = 0;
  for (const q of questions) {
    earned += scores[q]?.score ?? 0;
  }
  return Math.floor((earned / max) * 100);
}

function getTier(score: number): string {
  if (score < 40) return "Hidden";
  if (score < 70) return "Emerging";
  if (score < 85) return "AI-Ready";
  return "AI-Optimized";
}

/**
 * Confidence reflects how much real crawl data was available.
 * More pages = better. Errors, JS-only rendering, and robots blocks reduce it.
 */
function calcConfidence(
  pages: PageData[],
  robots: RobotsMeta,
  errorCount: number,
): "high" | "medium" | "low" {
  let points = 0;

  // Pages crawled
  if (pages.length >= 5) points += 3;
  else if (pages.length >= 3) points += 2;
  else points += 1;

  // Crawl errors reduce reliability
  if (errorCount >= 3) points -= 2;
  else if (errorCount >= 1) points -= 1;

  // JS-only site — content was harder to extract
  if (pages[0]?.isJSSite) points -= 1;

  // Robots.txt blocking AI crawlers signals restricted access
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

// ─── Main export ──────────────────────────────────────────────────────────────

export function calculateScore(
  aiScores: ClaudeResponse,
  pages: PageData[],
  robots: RobotsMeta,
  errorCount: number = 0,
  layer1?: Layer1Signals,
): FinalScore {
  // Merge AI scores with Layer 1 programmatic scores.
  // Layer 1 values always overwrite Claude's output for q2 and q3.
  // If pre-computed layer1 signals exist, calcQ2 uses them to avoid duplication.
  const allScores: ClaudeResponse = {
    ...aiScores,
    q2: calcQ2(pages, robots, layer1),
    q3: calcQ3(pages),
  };

  // Calculate each pillar as a 0–100 percentage
  const pillars: Record<string, number> = {};
  for (const [pillar, questions] of Object.entries(PILLARS)) {
    pillars[pillar] = calcPillar(questions, allScores);
  }

  // Weighted sum → final score (0–100)
  const total = Object.entries(WEIGHTS).reduce(
    (sum, [pillar, weight]) => sum + (pillars[pillar] ?? 0) * weight,
    0,
  );
  const score = Math.round(total);

  // Flat answers map for the response body
  const answers: Record<string, number> = {};
  for (const [q, val] of Object.entries(allScores)) {
    answers[q] = val.score;
  }

  // Prefer the page at "/" over positional index 0 — some crawl orders put
  // a redirected sub-page first when the root URL redirects.
  const homepage =
    pages.find((p) => {
      try {
        return new URL(p.url).pathname === "/";
      } catch {
        return false;
      }
    }) ?? pages[0];

  const businessName = homepage?.businessName ?? "";

  // Fallback chain: meta description → first meaningful sentence → raw slice
  const rawBody = homepage?.bodyText ?? "";
  const meaningfulSnippet =
    rawBody
      .split(/[.?!]/)
      .find((s) => s.trim().length > 40)
      ?.trim() ?? "";
  const businessDescription =
    homepage?.metaDescription || meaningfulSnippet || rawBody.slice(0, 200);

  return {
    score,
    tier: getTier(score),
    pillars,
    answers,
    scores: allScores,
    businessName,
    businessDescription,
    confidence: calcConfidence(pages, robots, errorCount),
  };
}
