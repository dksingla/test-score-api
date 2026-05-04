import Anthropic from "@anthropic-ai/sdk";
import { getClaudeSystemPrompt } from "./claudePrompt";
import type { Layer1Signals } from "./layer1";
import type { PageData } from "./types";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const MODEL = "claude-haiku-4-5";

function readTimeoutMs(envValue: string | undefined, fallback: number): number {
  const parsed = Number(envValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const CLAUDE_TIMEOUT_MS = readTimeoutMs(
  process.env.CLAUDE_API_TIMEOUT_MS ?? process.env.CLAUDE_TIMEOUT_MS,
  120_000,
);

const ABOUT_REGEX = /about|about us|our story|team|founder/i;
const SERVICES_REGEX =
  /services|products|solutions|what we do|how we help|service|solution|offerings|capabilities/i;
const BLOG_REGEX = /blog|articles|insights|resources|news|latest|post|article/i;
const CASE_STUDY_REGEX =
  /case studies|case study|success stories|success story|results|portfolio|our work/i;
const TESTIMONIAL_REGEX =
  /testimonials|testimonial|reviews|review|what clients say|client stories/i;
const FAQ_REGEX = /faq|frequently asked|questions/i;
const CONTACT_REGEX = /contact|get in touch|book a call|schedule a call|talk to us/i;

const CLAUDE_QUESTION_IDS = [
  "q1",
  "q4",
  "q5",
  "q6",
  "q7",
  "q8",
  "q9",
  "q11",
  "q13",
  "q14",
  "q15",
  "q16",
] as const;

type ClaudeQuestionId = (typeof CLAUDE_QUESTION_IDS)[number];

export interface ClaudeScore {
  score: number;
  reasoning: string;
}

export interface PriorityFix {
  rank: number;
  question_ref: string;
  pillar: string;
  issue: string;
  fix: string;
}

export interface ClaudeSuccessResponse {
  business_name: string;
  scores: Record<ClaudeQuestionId, ClaudeScore>;
  priority_fixes: PriorityFix[];
}

export interface ClaudeFailureResponse {
  error: "scoring_failed";
  message: "Unable to complete AI analysis. Please try again.";
}

export type ClaudeResponse = ClaudeSuccessResponse | ClaudeFailureResponse;

interface TrimmedPage {
  url: string;
  title: string;
  meta_description: string;
  h1: string[];
  h2: string[];
  h3: string[];
  body_excerpt: string;
  cta_texts: string[];
  has_form: boolean;
  has_email_form: boolean;
  word_count: number;
  list_count: number;
  table_count: number;
  blockquote_count: number;
  outbound_domains: string[];
  schemas_detected: string[];
  date_modified: string | null;
}

interface Payload {
  url: string;
  layer1_signals: {
    schemas_detected: string[];
    social_profiles: string[];
    ga4_detected: boolean;
    gtm_detected: boolean;
    pagespeed_mobile: number | null;
    forms_detected: number;
    forms_with_email: number;
    blog_posts_last_60_days: number;
    case_study_count: number;
    person_schema_on_about: boolean;
    review_schema_present: boolean;
  };
  site_summary: {
    business_names: string[];
    unique_h1s: string[];
    unique_h2s: string[];
    social_profile_count: number;
    total_forms: number;
    total_ctas: number;
    latest_date_modified: string | null;
  };
  pages: {
    homepage: TrimmedPage | null;
    about: TrimmedPage | null;
    services: TrimmedPage | null;
    contact: TrimmedPage | null;
    blog_sample: TrimmedPage | null;
    case_studies: TrimmedPage | null;
    testimonials: TrimmedPage | null;
    faq: TrimmedPage | null;
  };
}

function limitWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")} ...`;
}

function extractSchemaTypes(page: PageData): string[] {
  const detected = new Set<string>();

  for (const raw of page.schemas) {
    const matches = raw.matchAll(/"@type"\s*:\s*("(.*?)"|\[(.*?)\])/gi);
    for (const match of matches) {
      const single = match[2];
      const arrayBlock = match[3];

      if (single) {
        detected.add(single);
      }

      if (arrayBlock) {
        for (const item of arrayBlock.matchAll(/"(.*?)"/g)) {
          if (item[1]) detected.add(item[1]);
        }
      }
    }
  }

  return [...detected];
}

function hasPersonSchema(page: PageData | null): boolean {
  if (!page) return false;
  return extractSchemaTypes(page).some((type) => /person/i.test(type));
}

function extractOutboundDomains(page: PageData): string[] {
  return [
    ...new Set(
      page.outboundLinks
        .map((link) => {
          try {
            return new URL(link).hostname;
          } catch {
            return null;
          }
        })
        .filter((value): value is string => Boolean(value)),
    ),
  ].slice(0, 20);
}

function scorePageForIntent(page: PageData): number {
  const combined = [page.url, page.title, ...page.h1Tags, ...page.h2Tags]
    .join(" ")
    .toLowerCase();

  let score = 0;
  if (ABOUT_REGEX.test(combined)) score += 5;
  if (SERVICES_REGEX.test(combined)) score += 5;
  if (BLOG_REGEX.test(combined)) score += 4;
  if (CASE_STUDY_REGEX.test(combined)) score += 4;
  if (TESTIMONIAL_REGEX.test(combined)) score += 4;
  if (FAQ_REGEX.test(combined)) score += 3;
  if (CONTACT_REGEX.test(combined)) score += 3;
  if (page.hasForm) score += 2;
  if (page.hasEmailForm) score += 2;
  if (page.ctaTexts.length > 0) score += 2;
  if (page.wordCount > 800) score += 2;
  return score;
}

function pickBestPages(pages: PageData[]) {
  const sortFn = (a: PageData, b: PageData) =>
    scorePageForIntent(b) - scorePageForIntent(a);

  const homepage =
    pages.find((page) => {
      try {
        return new URL(page.url).pathname === "/";
      } catch {
        return false;
      }
    }) ?? pages[0];

  const findBest = (regex: RegExp): PageData | null =>
    pages
      .filter((page) =>
        regex.test([page.url, page.title, ...page.h1Tags, ...page.h2Tags].join(" ")),
      )
      .sort(sortFn)[0] ?? null;

  const recentBlogs = [...pages]
    .filter((page) =>
      BLOG_REGEX.test([page.url, page.title, ...page.h1Tags].join(" ")),
    )
    .sort((a, b) => {
      const aDate = a.dateModified ?? "";
      const bDate = b.dateModified ?? "";
      if (aDate !== bDate) return bDate.localeCompare(aDate);
      return b.wordCount - a.wordCount;
    });

  return {
    homepage,
    about: findBest(ABOUT_REGEX),
    services: findBest(SERVICES_REGEX),
    contact: findBest(CONTACT_REGEX),
    blogSample: recentBlogs[0] ?? null,
    caseStudies: findBest(CASE_STUDY_REGEX),
    testimonials: findBest(TESTIMONIAL_REGEX),
    faq: findBest(FAQ_REGEX),
    caseStudyCount: pages.filter((page) =>
      CASE_STUDY_REGEX.test([page.url, page.title, ...page.h1Tags].join(" ")),
    ).length,
    blogPostsLast60Days: recentBlogs.filter((page) =>
      isRecentWithinDays(page.dateModified, 60),
    ).length,
  };
}

function isRecentWithinDays(value: string | null, days: number): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  return Date.now() - parsed <= days * 24 * 60 * 60 * 1000;
}

function trimPage(page: PageData | null, maxWords: number): TrimmedPage | null {
  if (!page) return null;

  return {
    url: page.url,
    title: page.title,
    meta_description: page.metaDescription,
    h1: page.h1Tags.slice(0, 3),
    h2: page.h2Tags.slice(0, 10),
    h3: page.h3Tags.slice(0, 12),
    body_excerpt: limitWords(page.bodyText, maxWords),
    cta_texts: page.ctaTexts.slice(0, 8),
    has_form: page.hasForm,
    has_email_form: page.hasEmailForm,
    word_count: page.wordCount,
    list_count: page.unorderedListCount + page.orderedListCount,
    table_count: page.tableCount,
    blockquote_count: page.blockquoteCount,
    outbound_domains: extractOutboundDomains(page),
    schemas_detected: extractSchemaTypes(page),
    date_modified: page.dateModified,
  };
}

function buildSiteSummary(pages: PageData[]) {
  const businessNames = [
    ...new Set(pages.map((page) => page.businessName).filter(Boolean)),
  ].slice(0, 10);

  const socialProfiles = [
    ...new Set(
      pages.flatMap((page) =>
        [
          ...page.socialProfiles.linkedin,
          ...page.socialProfiles.facebook,
          ...page.socialProfiles.instagram,
          ...page.socialProfiles.x,
          ...page.socialProfiles.youtube,
          ...page.socialProfiles.tiktok,
          ...page.socialProfiles.pinterest,
        ].filter(Boolean),
      ),
    ),
  ];

  return {
    business_names: businessNames,
    unique_h1s: [...new Set(pages.flatMap((page) => page.h1Tags))].slice(0, 20),
    unique_h2s: [...new Set(pages.flatMap((page) => page.h2Tags))].slice(0, 30),
    social_profile_count: socialProfiles.length,
    total_forms: pages.filter((page) => page.hasForm).length,
    total_ctas: pages.reduce((sum, page) => sum + page.ctaTexts.length, 0),
    latest_date_modified:
      pages
        .map((page) => page.dateModified)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null,
    social_profiles: socialProfiles,
  };
}

function buildPayload(
  pages: PageData[],
  layer1?: Pick<Layer1Signals, "performance" | "conversion">,
): Payload {
  const selected = pickBestPages(pages);
  const siteSummary = buildSiteSummary(pages);
  const homepage = trimPage(selected.homepage ?? null, 1500);
  const about = trimPage(selected.about, 1500);
  const services = trimPage(selected.services, 1500);
  const contact = trimPage(selected.contact, 1500);
  const blogSample = trimPage(selected.blogSample, 2000);
  const caseStudies = trimPage(selected.caseStudies, 1500);
  const testimonials = trimPage(selected.testimonials, 1500);
  const faq = trimPage(selected.faq, 1500);

  const schemaTypes = [
    ...new Set(pages.flatMap((page) => extractSchemaTypes(page))),
  ].slice(0, 40);

  return {
    url: selected.homepage?.url ?? pages[0]?.url ?? "",
    layer1_signals: {
      schemas_detected: schemaTypes,
      social_profiles: siteSummary.social_profiles,
      ga4_detected: pages.some((page) => Boolean(page.ga4Id)),
      gtm_detected: pages.some((page) => Boolean(page.gtmId)),
      pagespeed_mobile: layer1?.performance.pageSpeedScore ?? null,
      forms_detected: pages.filter((page) => page.hasForm).length,
      forms_with_email:
        layer1?.conversion.totalFormsWithEmail ??
        pages.filter((page) => page.hasEmailForm).length,
      blog_posts_last_60_days: selected.blogPostsLast60Days,
      case_study_count: selected.caseStudyCount,
      person_schema_on_about: hasPersonSchema(selected.about),
      review_schema_present: pages.some(
        (page) => page.schemaSignals.reviewOrAggregateRating,
      ),
    },
    site_summary: {
      business_names: siteSummary.business_names,
      unique_h1s: siteSummary.unique_h1s,
      unique_h2s: siteSummary.unique_h2s,
      social_profile_count: siteSummary.social_profile_count,
      total_forms: siteSummary.total_forms,
      total_ctas: siteSummary.total_ctas,
      latest_date_modified: siteSummary.latest_date_modified,
    },
    pages: {
      homepage,
      about,
      services,
      contact,
      blog_sample: blogSample,
      case_studies: caseStudies,
      testimonials,
      faq,
    },
  };
}

const SYSTEM_PROMPT = getClaudeSystemPrompt();

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

function isValidPriorityFix(value: unknown): value is PriorityFix {
  if (!value || typeof value !== "object") return false;
  const fix = value as Record<string, unknown>;
  return (
    typeof fix.rank === "number" &&
    typeof fix.question_ref === "string" &&
    typeof fix.pillar === "string" &&
    typeof fix.issue === "string" &&
    typeof fix.fix === "string"
  );
}

function validateClaudeResponse(parsed: unknown): ClaudeSuccessResponse {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Claude response is not an object");
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.business_name !== "string") {
    throw new Error("Missing business_name");
  }

  if (!obj.scores || typeof obj.scores !== "object") {
    throw new Error("Missing scores object");
  }

  const scoresObj = obj.scores as Record<string, unknown>;
  const scores = {} as Record<ClaudeQuestionId, ClaudeScore>;

  for (const questionId of CLAUDE_QUESTION_IDS) {
    const entry = scoresObj[questionId];
    if (!entry || typeof entry !== "object") {
      throw new Error(`Missing ${questionId}`);
    }

    const scoreEntry = entry as Record<string, unknown>;
    const score = scoreEntry.score;
    const reasoning = scoreEntry.reasoning;

    if (![0, 1, 2].includes(score as number)) {
      throw new Error(`Invalid score for ${questionId}`);
    }

    if (typeof reasoning !== "string" || reasoning.trim().length === 0) {
      throw new Error(`Missing reasoning for ${questionId}`);
    }

    scores[questionId] = {
      score: score as number,
      reasoning: reasoning.trim(),
    };
  }

  if (!Array.isArray(obj.priority_fixes) || obj.priority_fixes.length < 3) {
    throw new Error("Missing priority_fixes");
  }

  const priorityFixes = obj.priority_fixes.filter(isValidPriorityFix);
  if (priorityFixes.length !== obj.priority_fixes.length) {
    throw new Error("Invalid priority_fixes entries");
  }

  return {
    business_name: obj.business_name.trim(),
    scores,
    priority_fixes: priorityFixes.slice(0, 5),
  };
}

async function runClaude(payload: Payload): Promise<string> {
  const response = await anthropic.messages.create(
    {
      model: MODEL,
      max_tokens: 4000,
      temperature: 0.2,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: JSON.stringify(payload, null, 2),
        },
      ],
    },
    {
      timeout: CLAUDE_TIMEOUT_MS,
    },
  );

  return response.content[0]?.type === "text" ? response.content[0].text : "";
}

function shouldRetryAnthropicError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const maybeError = error as {
    status?: number;
    error?: { type?: string };
    message?: string;
    name?: string;
  };

  if (typeof maybeError.status === "number") {
    return maybeError.status === 429 || maybeError.status >= 500;
  }

  if (maybeError.error?.type === "rate_limit_error") {
    return true;
  }

  const message = (maybeError.message ?? "").toLowerCase();
  return message.includes("timeout") || message.includes("timed out");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestClaudeAnalysis(payload: Payload): Promise<ClaudeResponse> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let raw: string;
    try {
      raw = await runClaude(payload);
    } catch (error) {
      console.error("[claude] anthropic api error", {
        attempt,
        url: payload.url,
        error,
      });

      if (attempt < 2 && shouldRetryAnthropicError(error)) {
        await sleep(2000);
        continue;
      }

      return {
        error: "scoring_failed",
        message: "Unable to complete AI analysis. Please try again.",
      };
    }

    try {
      const parsed = JSON.parse(extractJSON(raw));
      return validateClaudeResponse(parsed);
    } catch (error) {
      console.error("[claude] invalid response", {
        attempt,
        url: payload.url,
        error: error instanceof Error ? error.message : String(error),
        raw,
      });
    }
  }

  return {
    error: "scoring_failed",
    message: "Unable to complete AI analysis. Please try again.",
  };
}

export function buildDebugPayload(pages: PageData[]): {
  selectedPages: {
    homepage: PageData | undefined;
    about: PageData | null;
    services: PageData | null;
    contact: PageData | null;
    blogSample: PageData | null;
    caseStudies: PageData | null;
    testimonials: PageData | null;
    faq: PageData | null;
  };
  trimmedPayload: Payload;
  promptText: string;
} {
  const selected = pickBestPages(pages);
  const trimmedPayload = buildPayload(pages);

  return {
    selectedPages: {
      homepage: selected.homepage,
      about: selected.about,
      services: selected.services,
      contact: selected.contact,
      blogSample: selected.blogSample,
      caseStudies: selected.caseStudies,
      testimonials: selected.testimonials,
      faq: selected.faq,
    },
    trimmedPayload,
    promptText: `SYSTEM PROMPT:\n${SYSTEM_PROMPT}\n\nUSER PAYLOAD:\n${JSON.stringify(trimmedPayload, null, 2)}`,
  };
}

export async function getClaudeScores(
  pages: PageData[],
  layer1?: Pick<Layer1Signals, "performance" | "conversion">,
): Promise<ClaudeResponse> {
  const payload = buildPayload(pages, layer1);
  return requestClaudeAnalysis(payload);
}
