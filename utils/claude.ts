import Anthropic from "@anthropic-ai/sdk";
import type { PageData } from "./types";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const MODEL = "claude-haiku-4-5";

interface ClaudeScore {
  score: number;
  reason: string;
}

export type ClaudeResponse = Record<string, ClaudeScore>;

const ABOUT_REGEX = /about|about us|our story|team/;
const SERVICES_REGEX =
  /services|products|solutions|what we do|how we help|service|solution/;
const BLOG_REGEX =
  /blog|articles|insights|resources|news|latest|post|article/;
const PROOF_REGEX =
  /case studies|case study|success stories|results|portfolio|work|testimonials|reviews/;

// ─── Page scoring ─────────────────────────────────────────────────────────────

/**
 * Rates how content-rich and intent-relevant a page is.
 * Used to pick the best pages to send to Claude regardless of URL naming.
 */
function scorePageForIntent(page: PageData): number {
  const url = page.url.toLowerCase();
  const h1 = page.h1Tags.join(" ").toLowerCase();
  const text = page.bodyText.slice(0, 500).toLowerCase();

  let score = 0;

  if (
    ABOUT_REGEX.test(url) ||
    ABOUT_REGEX.test(h1) ||
    text.includes("about us")
  )
    score += 5;
  if (
    SERVICES_REGEX.test(url) ||
    SERVICES_REGEX.test(h1)
  )
    score += 5;
  if (BLOG_REGEX.test(url) || BLOG_REGEX.test(h1))
    score += 4;
  if (PROOF_REGEX.test(url) || PROOF_REGEX.test(h1)) score += 4;
  if (url.includes("contact") || h1.includes("contact")) score += 3;

  if (page.hasForm) score += 2;
  if (page.ctaTexts.length > 0) score += 2;
  if (page.bodyText.length > 1000) score += 2;

  return score;
}

/**
 * Assigns pages to intent buckets via regex on URL + title + H1, then picks
 * the highest-scoring page from each bucket.
 *
 * Bucket matching handles non-standard naming (/who-we-help, /solutions,
 * /insights) that single-keyword lookups miss.
 * Falls back to positional rank only when a bucket is completely empty.
 */
function pickBestPages(pages: PageData[]) {
  const buckets = {
    about: [] as PageData[],
    services: [] as PageData[],
    blog: [] as PageData[],
    proof: [] as PageData[],
  };

  for (const p of pages) {
    const text = [p.url, p.title, ...p.h1Tags].join(" ").toLowerCase();

    if (ABOUT_REGEX.test(text)) {
      buckets.about.push(p);
    }
    if (SERVICES_REGEX.test(text)) {
      buckets.services.push(p);
    }
    if (BLOG_REGEX.test(text)) {
      buckets.blog.push(p);
    }
    if (PROOF_REGEX.test(text)) {
      buckets.proof.push(p);
    }
  }

  const sortFn = (a: PageData, b: PageData) =>
    scorePageForIntent(b) - scorePageForIntent(a);

  // Prefer the page whose pathname is exactly "/" — handles crawl orders where
  // a redirect or sub-page ends up at index 0.
  const homepage =
    pages.find((p) => {
      try {
        return new URL(p.url).pathname === "/";
      } catch {
        return false;
      }
    }) ?? pages[0];

  return {
    homepage,
    about: buckets.about.sort(sortFn)[0] ?? null,
    services: buckets.services.sort(sortFn)[0] ?? null,
    blog: buckets.blog.sort(sortFn).slice(0, 3),
    proof: buckets.proof.sort(sortFn).slice(0, 2),
  };
}

// ─── Signal extraction ────────────────────────────────────────────────────────

/**
 * Filters body text down to sentences that carry business/intent signals.
 * ~60–70% token reduction vs sending raw body text while keeping the
 * highest-density content for Claude.
 */
function extractImportantText(text: string): string {
  return text
    .split(/[.?!]/)
    .filter(
      (s) =>
        s.length > 40 &&
        /we |help|offer|service|solution|result|client|customer|problem|benefit/.test(
          s.toLowerCase(),
        ),
    )
    .slice(0, 10)
    .join(". ")
    .trim();
}

function trimPage(p: PageData, isHomepage = false) {
  return {
    url: p.url,
    title: p.title,
    h1Tags: p.h1Tags.slice(0, 3),
    h2Tags: p.h2Tags.slice(0, 5),
    // Homepage gets raw body text for richer Q1 evaluation;
    // inner pages use compressed signal sentences to save tokens.
    keyContent: isHomepage
      ? p.bodyText.slice(0, 800)
      : extractImportantText(p.bodyText),
    // Counts only — Claude doesn't reason well over raw arrays for these fields
    schemaCount: p.schemas.length,
    outboundDomainCount: p.outboundLinks.length,
    // Layer 1 hybrid signals — used by Claude for Q13 and Q14 evaluation
    hasForm: p.hasForm,
    ctaTexts: p.ctaTexts.slice(0, 5),
    wordCount: p.wordCount,
    unorderedListCount: p.unorderedListCount,
    orderedListCount: p.orderedListCount,
    tableCount: p.tableCount,
    blockquoteCount: p.blockquoteCount,
    dateModified: p.dateModified,
  };
}

// ─── Site summary ─────────────────────────────────────────────────────────────

const INDUSTRY_KEYWORDS = [
  "seo",
  "marketing",
  "agency",
  "software",
  "consulting",
  "design",
  "ai",
  "automation",
] as const;

/**
 * Pre-aggregates intelligence across ALL crawled pages before sending to Claude.
 * Claude is poor at cross-object aggregation — doing it here makes Q10/Q11/Q12
 * dramatically more accurate.
 *
 * keywordFrequency gives Claude a data-driven signal for positioning consistency
 * (Q11) and niche identification (Q10/Q12) without requiring it to read all pages.
 */
function buildSiteSummary(pages: PageData[]) {
  const allText = pages
    .map((p) => p.bodyText)
    .join(" ")
    .toLowerCase();

  const keywordFrequency: Record<string, number> = {};
  for (const word of INDUSTRY_KEYWORDS) {
    keywordFrequency[word] = (
      allText.match(new RegExp(word, "g")) ?? []
    ).length;
  }

  return {
    uniqueH1s: [...new Set(pages.flatMap((p) => p.h1Tags))].slice(0, 20),
    uniqueH2s: [...new Set(pages.flatMap((p) => p.h2Tags))].slice(0, 20),
    combinedText: allText.slice(0, 3000),
    keywordFrequency,
    totalForms: pages.filter((p) => p.hasForm).length,
    totalCTAs: pages.reduce((sum, p) => sum + p.ctaTexts.length, 0),
    analyticsPresent: pages.some((p) => p.ga4Id !== null || p.gtmId !== null),
    schemaTypes: {
      faq: pages.some((p) => p.schemaSignals.faq),
      productOrService: pages.some((p) => p.schemaSignals.productOrService),
      localBusinessOrOrganization: pages.some(
        (p) => p.schemaSignals.localBusinessOrOrganization,
      ),
      reviewOrAggregateRating: pages.some(
        (p) => p.schemaSignals.reviewOrAggregateRating,
      ),
    },
    latestDateModified:
      pages
        .map((p) => p.dateModified)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null,
    socialProfiles: {
      linkedin: [...new Set(pages.flatMap((p) => p.socialProfiles.linkedin))],
      facebook: [...new Set(pages.flatMap((p) => p.socialProfiles.facebook))],
      instagram: [...new Set(pages.flatMap((p) => p.socialProfiles.instagram))],
      x: [...new Set(pages.flatMap((p) => p.socialProfiles.x))],
      youtube: [...new Set(pages.flatMap((p) => p.socialProfiles.youtube))],
      tiktok: [...new Set(pages.flatMap((p) => p.socialProfiles.tiktok))],
      pinterest: [...new Set(pages.flatMap((p) => p.socialProfiles.pinterest))],
    },
    outboundDomains: [
      ...new Set(
        pages
          .flatMap((p) => p.outboundLinks)
          .map((l) => {
            try {
              return new URL(l).hostname;
            } catch {
              return null;
            }
          })
          .filter((h): h is string => h !== null),
      ),
    ].slice(0, 15),
  };
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

interface Payload {
  homepage: ReturnType<typeof trimPage> | null;
  about: ReturnType<typeof trimPage> | null;
  services: ReturnType<typeof trimPage> | null;
  blog: ReturnType<typeof trimPage>[];
  proof: ReturnType<typeof trimPage>[];
  siteSummary: ReturnType<typeof buildSiteSummary>;
  isThinSite: boolean;
}

function buildPrompt(payload: Payload): string {
  return `You are evaluating a business website for AI visibility and recommendation readiness using the FIREUP Framework.

Score each question from 0 to 2:
  0 = not present or clearly fails the criteria
  1 = partially present, some signals exist
  2 = strong, clearly and consistently meets the criteria

SCORING RULES (follow strictly):
- If a signal is not explicitly present in the provided data, score it 0. Do NOT assume or infer missing information.
- Each reason MUST reference a specific signal from the data (a heading, CTA text, body sentence, or summary field). Generic reasons are not acceptable.
- Most websites should score 0 or 1. Only award 2 when strong, repeated evidence exists across multiple data points.
- Be strict and consistent. Prefer a lower score unless the data clearly and explicitly justifies a higher one.
- If isThinSite is true, all content-related questions (Q4, Q5, Q6) MUST score 0 unless strong, explicit evidence exists in the provided text to the contrary.

Return ONLY valid JSON. No markdown. No explanation outside the JSON object.

Required format (evaluate exactly these 13 questions — q2 and q3 are handled separately, do NOT include them):
{
  "q1":  { "score": 0|1|2, "reason": "one sentence max" },
  "q4":  { "score": 0|1|2, "reason": "one sentence max" },
  "q5":  { "score": 0|1|2, "reason": "one sentence max" },
  "q6":  { "score": 0|1|2, "reason": "one sentence max" },
  "q7":  { "score": 0|1|2, "reason": "one sentence max" },
  "q8":  { "score": 0|1|2, "reason": "one sentence max" },
  "q9":  { "score": 0|1|2, "reason": "one sentence max" },
  "q10": { "score": 0|1|2, "reason": "one sentence max" },
  "q11": { "score": 0|1|2, "reason": "one sentence max" },
  "q12": { "score": 0|1|2, "reason": "one sentence max" },
  "q13": { "score": 0|1|2, "reason": "one sentence max" },
  "q14": { "score": 0|1|2, "reason": "one sentence max" },
  "q15": { "score": 0|1|2, "reason": "one sentence max" }
}

SCORING CRITERIA:

Q1  (Foundation — Homepage Clarity)
    Does the homepage hero clearly state WHO they help and WHAT specific problem they solve?
    0 = vague or generic headline with no clear audience or problem
    1 = partially clear — audience OR problem mentioned but not both
    2 = hero immediately and specifically names the audience and the problem/outcome

Q4  (Intent — Content Freshness & Depth)
    Does the blog/content section show recent, substantial posts? Is there a flagship anchor asset?
    0 = no blog, or only old/thin posts
    1 = blog exists with some posts but lacks recency or depth
    2 = active blog with recent substantial posts and/or a signature piece of content

Q5  (Intent — Buyer Question Answering)
    Does the content directly answer common buyer questions in a way an AI model could reuse?
    Look specifically for: FAQ-style headings, question-based H2s (e.g. "How does X work?"), or explanatory sections that address objections.
    0 = content is self-promotional only, no Q&A or FAQ-style content
    1 = some buyer questions addressed but inconsistently
    2 = content clearly and thoroughly answers buyer questions, FAQs, or objections

Q6  (Intent — Content Structure)
    Is content structured with clear H1/H2 headings, short paragraphs, and answer-first formatting?
    Look specifically for: multiple H2 sections in the data, descriptive (not vague) heading text, and clear section separation.
    0 = wall-of-text, fewer than 2 H2s, or no heading structure
    1 = some structure but inconsistent or headings are vague
    2 = well-structured with multiple descriptive H2s and scannable formatting throughout

Q7  (Expertise — Testimonial Quality)
    Are testimonials specific with measurable outcomes, or just generic praise?
    0 = no testimonials, or only generic ("great service!")
    1 = some testimonials but lack specifics or outcomes
    2 = testimonials include specific results, measurable outcomes, and named sources

Q8  (Expertise — Case Study Depth)
    Is there at least one detailed case study showing the problem, process, and measurable result?
    0 = no case studies
    1 = brief success story but missing problem/process/result structure
    2 = at least one full case study with clear problem, process, and quantifiable result

Q9  (Expertise — About Page Authority)
    Does the About page convey specific expertise, years of experience, and a clear point of view?
    0 = generic bio or no About page
    1 = some credentials mentioned but vague or unfocused
    2 = clear expertise, specific experience, strong POV, and named person/team

Q10 (Unify — Search & Brand Presence)
    Based on outboundDomains and brand signals in the SITE SUMMARY, does this business appear consistently present online?
    0 = no social links, no external mentions, no directory presence
    1 = some online presence but sparse or inconsistent
    2 = active across multiple channels with consistent branding signals

Q11 (Relevance — Positioning Consistency)
    Using the SITE SUMMARY combinedText and uniqueH1s/uniqueH2s, is the niche and positioning consistent across ALL crawled pages?
    0 = messaging is inconsistent or contradictory across pages
    1 = mostly consistent but with some off-message pages
    2 = clear, consistent niche and positioning across every page evaluated

Q12 (Unify — External Mentions & Authority)
    Are there references to guest content, press mentions, podcast appearances, or directory listings?
    0 = no external references found
    1 = one or two passing mentions
    2 = clear evidence of external mentions, guest posts, press, or reputable directory presence

Q13 (Performance — Lead Magnet Alignment) [HYBRID]
    Layer 1 detected: hasForm and ctaTexts are in the page data below.
    Evaluate whether the opt-in offer / lead magnet ALIGNS with the main service offered.
    0 = no form detected OR form exists but offer is misaligned with the core service
    1 = form exists, offer is related but loosely aligned
    2 = form exists with a highly relevant offer that directly supports the main service

Q14 (Performance — CTA Clarity) [HYBRID]
    Layer 1 detected: ctaTexts are in the page data and in the SITE SUMMARY below.
    Evaluate whether CTAs are clear, specific, and consistent across pages.
    0 = no CTAs found, or CTAs are vague ("click here", "learn more")
    1 = CTAs exist but are generic or inconsistent
    2 = CTAs are action-oriented, specific, and consistently reinforce the main offer

Q15 (Performance — Email / Follow-up System)
    Is there evidence of an email nurture sequence, follow-up path, or retargeting system?
    0 = no evidence of email capture or follow-up system
    1 = email capture exists but no evidence of a sequence or nurture path
    2 = clear evidence of lead nurture, email sequence, or retargeting (e.g. cookie consent, drip copy)

SITE SUMMARY:
This is a pre-aggregated view across ALL crawled pages. Use it for global judgments about positioning consistency (Q11), brand presence (Q10), and authority signals (Q12). It contains aggregated headings, combined body text, total form/CTA counts, and all outbound domains found across the site.
${JSON.stringify(payload.siteSummary, null, 2)}

PAGE DATA:
${JSON.stringify(
  {
    homepage: payload.homepage,
    about: payload.about,
    services: payload.services,
    blog: payload.blog,
    proof: payload.proof,
  },
  null,
  2,
)}`;
}

// ─── Debug export ────────────────────────────────────────────────────────────

/**
 * Returns the exact payload and prompt that would be sent to Claude,
 * without making any API call. Used by /api/debug for inspection.
 */
export function buildDebugPayload(pages: PageData[]): {
  selectedPages: {
    homepage: PageData | undefined;
    about: PageData | null;
    services: PageData | null;
    blog: PageData[];
    proof: PageData[];
  };
  trimmedPayload: Payload;
  promptText: string;
  isThinSite: boolean;
} {
  const selected = pickBestPages(pages);
  const isThinSite = pages.every((p) => p.bodyText.length < 500);

  const trimmedPayload: Payload = {
    homepage: selected.homepage ? trimPage(selected.homepage, true) : null,
    about: selected.about ? trimPage(selected.about) : null,
    services: selected.services ? trimPage(selected.services) : null,
    blog: selected.blog.map((p) => trimPage(p)),
    proof: selected.proof.map((p) => trimPage(p)),
    siteSummary: buildSiteSummary(pages),
    isThinSite,
  };

  return {
    selectedPages: {
      homepage: selected.homepage,
      about: selected.about,
      services: selected.services,
      blog: selected.blog,
      proof: selected.proof,
    },
    trimmedPayload,
    promptText: buildPrompt(trimmedPayload),
    isThinSite,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function getClaudeScores(
  pages: PageData[],
): Promise<ClaudeResponse> {
  const selected = pickBestPages(pages);

  const isThinSite = pages.every((p) => p.bodyText.length < 500);

  const payload: Payload = {
    homepage: selected.homepage ? trimPage(selected.homepage, true) : null,
    about: selected.about ? trimPage(selected.about) : null,
    services: selected.services ? trimPage(selected.services) : null,
    blog: selected.blog.map((p) => trimPage(p)),
    proof: selected.proof.map((p) => trimPage(p)),
    siteSummary: buildSiteSummary(pages),
    isThinSite,
  };

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: buildPrompt(payload),
      },
    ],
  });

  const raw =
    response.content[0]?.type === "text" ? response.content[0].text : "";

  try {
    return JSON.parse(extractJSON(raw)) as ClaudeResponse;
  } catch {
    console.error("Claude RAW response:", raw);
    throw new Error(`Claude returned invalid JSON: ${raw.slice(0, 300)}`);
  }
}

/**
 * Strips markdown code fences and extracts the outermost JSON object.
 * Handles:
 *   ```json { ... } ```
 *   ```{ ... }```
 *   Plain { ... }
 */
function extractJSON(text: string): string {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");

  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON object found");
  }

  return stripped.slice(start, end + 1);
}
