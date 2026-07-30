import Anthropic from "@anthropic-ai/sdk";
import { getClaudeSystemPrompt } from "./claudePrompt";
import { calcQ2, calcQ3, calcQ17, calcQ18 } from "./layer1Calculators";
import type { Layer1Signals } from "./layer1";
import type { PageData, RobotsMeta } from "./types";

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
  240_000,
);

const ABOUT_REGEX = /about|about us|our story|team|founder/i;
const SERVICES_REGEX =
  /services|products|solutions|what we do|how we help|service|solution|offerings|capabilities/i;
const BLOG_REGEX = /blog|articles|insights|resources|news|latest|post|article/i;
const CASE_STUDY_REGEX =
  /case[-\s]+stud(?:y|ies)|success[-\s]+stor(?:y|ies)|results|portfolio|our work/i;
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
type EvidenceStatus = "verified" | "unknown";

interface QuestionEvidence {
  status: EvidenceStatus;
  reason: string;
}

export interface ClaudeScore {
  score: number;
  reasoning: string;
  evidence_status?: "verified" | "unknown";
}

export interface PriorityFix {
  rank: number;
  question_ref: string;
  pillar: string;
  issue: string;
  fix: string;
}

const QUESTION_TO_PILLAR: Record<string, string> = {
  q1: "intent",
  q2: "foundation",
  q3: "foundation",
  q4: "relevance",
  q5: "relevance",
  q6: "relevance",
  q7: "expertise",
  q8: "expertise",
  q9: "expertise",
  q11: "unify",
  q13: "intent",
  q14: "performance",
  q15: "performance",
  q16: "expertise",
  q17: "unify",
  q18: "performance",
};

const PILLAR_ALIASES: Record<string, string> = {
  foundation: "foundation",
  intent: "intent",
  relevance: "relevance",
  expertise: "expertise",
  unify: "unify",
  performance: "performance",
  content: "relevance",
  credibility: "expertise",
  social_proof: "expertise",
  conversion: "intent",
};

const PILLAR_FIX_WEIGHTS: Record<string, number> = {
  foundation: 20,
  relevance: 20,
  expertise: 20,
  intent: 15,
  unify: 15,
  performance: 10,
};

const VERIFIED_FALLBACK_FIXES: Record<
  string,
  Pick<PriorityFix, "issue" | "fix">
> = {
  q1: {
    issue: "Clarify key-page messaging",
    fix: "Make the audience, promised outcome, and next step explicit across the verified key pages that scored below full strength.",
  },
  q2: {
    issue: "Strengthen verified technical gaps",
    fix: "The completed technical checks found room to improve. Prioritize the failed speed, metadata, schema, sitemap, or crawler-access checks shown in the score.",
  },
  q3: {
    issue: "Complete analytics coverage",
    fix: "The verified analytics check found incomplete tracking. Configure a supported Google tag or Tag Manager container across the site.",
  },
  q4: {
    issue: "Strengthen publishing consistency",
    fix: "The verified content sample scored below full strength. Improve publishing cadence and make each article more substantive.",
  },
  q5: {
    issue: "Answer more buyer questions",
    fix: "Strengthen the verified content with direct answers to the questions prospects ask before choosing your service.",
  },
  q6: {
    issue: "Improve content structure",
    fix: "Make the verified pages easier to scan with descriptive headings, answer-first sections, lists, and other useful structure.",
  },
  q7: {
    issue: "Strengthen testimonial proof",
    fix: "Improve the verified testimonials with named sources, specific outcomes, and measurable details that make the results credible.",
  },
  q8: {
    issue: "Strengthen case study narratives",
    fix: "Improve the verified case studies by making each client problem, your process, and the measurable result easy to identify.",
  },
  q9: {
    issue: "Strengthen visible expertise",
    fix: "Improve the verified About content with specific credentials, experience, and a clear point of view.",
  },
  q11: {
    issue: "Align positioning across pages",
    fix: "Make the verified pages use a consistent business name, audience, offer, and core positioning.",
  },
  q13: {
    issue: "Clarify lead magnet alignment",
    fix: "A lead magnet was verified. Make its connection to your primary service and intended next step immediately clear.",
  },
  q14: {
    issue: "Clarify primary calls to action",
    fix: "Give each verified key page one clear, specific primary action that matches the page purpose.",
  },
  q15: {
    issue: "Strengthen email follow-up",
    fix: "The verified email path scored below full strength. Clarify what subscribers receive and how the follow-up supports the main offer.",
  },
  q16: {
    issue: "Add stronger supporting evidence",
    fix: "Strengthen the verified content with reputable citations, substantive data, or attributed expert quotations.",
  },
  q17: {
    issue: "Strengthen social profile coverage",
    fix: "Expand the verified social links and keep business identity and positioning consistent across active profiles.",
  },
  q18: {
    issue: "Refresh visible content",
    fix: "The verified freshness signal is below full strength. Update important pages and publish current, substantive material.",
  },
};

function normalizePriorityFix(fix: PriorityFix): PriorityFix {
  const questionRef = fix.question_ref.trim().toLowerCase();
  const rawPillar =
    typeof fix.pillar === "string" ? fix.pillar.trim().toLowerCase() : "";
  const canonicalPillar =
    QUESTION_TO_PILLAR[questionRef] ??
    PILLAR_ALIASES[rawPillar] ??
    rawPillar;

  return {
    ...fix,
    question_ref: questionRef,
    pillar: canonicalPillar || "unknown",
  };
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
  email_capture_evidence: string[];
  word_count: number;
  list_count: number;
  table_count: number;
  blockquote_count: number;
  outbound_domains: string[];
  schemas_detected: string[];
  date_published: string | null;
  date_modified: string | null;
}

interface Payload {
  url: string;
  layer1_signals: {
    schemas_detected: string[];
    social_profiles: string[];
    ga4_detected: boolean | null;
    google_tag_detected: boolean | null;
    gtm_detected: boolean | null;
    pagespeed_mobile: number | null;
    forms_detected: number | null;
    forms_with_email: number | null;
    email_capture_detected: boolean;
    email_sequence_evidence: boolean;
    blog_posts_last_60_days: number | null;
    blog_posts_last_90_days: number | null;
    blog_posts_last_12_months: number | null;
    blog_listing_title: string | null;
    recent_blog_sample_captured: boolean;
    case_study_count: number | null;
    person_schema_on_about: boolean;
    review_schema_present: boolean;
    q2_score: number;
    q3_score: number;
    q17_score: number;
    q18_score: number;
  };
  question_evidence: Record<string, QuestionEvidence>;
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
    blog_listing: TrimmedPage | null;
    blog_sample: TrimmedPage | null;
    case_studies: TrimmedPage | null;
    case_study_samples: TrimmedPage[];
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

  const listingEntryUrls = new Set(
    pages
      .flatMap((page) => page.blogListingEntries)
      .map((entry) => entry.url.replace(/\/+$/, "")),
  );
  const recentBlogs = [...pages]
    .filter(
      (page) =>
        isLikelyBlogDetailPage(page) ||
        listingEntryUrls.has(page.url.replace(/\/+$/, "")),
    )
    .sort((a, b) => {
      const aDate = a.dateModified ?? "";
      const bDate = b.dateModified ?? "";
      if (aDate !== bDate) return bDate.localeCompare(aDate);
      return b.wordCount - a.wordCount;
    });
  const blogListing =
    [...pages]
      .filter((page) => page.blogListingEntries.length > 0)
      .sort(
        (a, b) =>
          b.blogListingEntries.length - a.blogListingEntries.length ||
          sortFn(a, b),
      )[0] ??
    findBest(BLOG_REGEX);
  const datedBlogInventory = new Map<
    string,
    { url: string; title: string; datePublished: string }
  >();

  for (const entry of pages.flatMap((page) => page.blogListingEntries)) {
    const key = entry.url.replace(/\/+$/, "");
    const existing = datedBlogInventory.get(key);
    if (!existing || entry.datePublished > existing.datePublished) {
      datedBlogInventory.set(key, entry);
    }
  }
  for (const page of recentBlogs) {
    const publishedDate = page.datePublished ?? page.dateModified;
    if (!publishedDate) continue;
    const key = page.url.replace(/\/+$/, "");
    if (!datedBlogInventory.has(key)) {
      datedBlogInventory.set(key, {
        url: page.url,
        title: page.title,
        datePublished: publishedDate,
      });
    }
  }
  const blogInventory = [...datedBlogInventory.values()].sort((a, b) =>
    b.datePublished.localeCompare(a.datePublished),
  );
  const countRecentInventory = (days: number) =>
    blogInventory.filter((entry) =>
      isRecentWithinDays(entry.datePublished, days),
    ).length;
  const blogPostsLast60Days = countRecentInventory(60);
  const blogPostsLast90Days = countRecentInventory(90);
  const blogPostsLast12Months = countRecentInventory(365);

  const caseStudyCandidates = [...pages]
    .filter((page) =>
      CASE_STUDY_REGEX.test(
        [page.url, page.title, ...page.h1Tags].join(" "),
      ),
    )
    .sort(sortFn);
  const caseStudyDetails = caseStudyCandidates
    .filter(isLikelyCaseStudyDetailPage)
    .sort((a, b) => b.wordCount - a.wordCount);
  const blogDiagnostics = pages.map((page) => {
    const evidence = getBlogDetailEvidence(page);
    const parsedDate = page.dateModified
      ? Date.parse(page.dateModified)
      : Number.NaN;
    const ageDays = Number.isNaN(parsedDate)
      ? null
      : Math.round(
          ((Date.now() - parsedDate) / (24 * 60 * 60 * 1000)) * 10,
        ) / 10;

    return {
      url: page.url,
      title: page.title,
      accepted: evidence.accepted,
      reason: evidence.reason,
      pathMatched: evidence.pathMatched,
      articleSchemaMatched: evidence.articleSchemaMatched,
      schemaTypes: evidence.schemaTypes,
      dateModified: page.dateModified,
      datePublished: page.datePublished,
      ageDays,
      within60Days: isRecentWithinDays(page.dateModified, 60),
      wordCount: page.wordCount,
    };
  });
  console.log("[claude][q4] blog evidence summary", {
    totalCrawledPages: pages.length,
    acceptedBlogPages: blogDiagnostics.filter((page) => page.accepted),
    rejectedPages: blogDiagnostics
      .filter((page) => !page.accepted)
      .map((page) => ({
        url: page.url,
        title: page.title,
        reason: page.reason,
        schemaTypes: page.schemaTypes,
        dateModified: page.dateModified,
      })),
    selectedBlogSample: recentBlogs[0]?.url ?? null,
    selectedBlogListing: blogListing?.url ?? null,
    datedListingInventory: blogInventory.slice(0, 30),
    blogPostsLast60Days,
    blogPostsLast90Days,
    blogPostsLast12Months,
    q4EvidenceStatus: blogInventory.length > 0 ? "verified" : "unknown",
  });

  return {
    homepage,
    about: findBest(ABOUT_REGEX),
    services: findBest(SERVICES_REGEX),
    contact: findBest(CONTACT_REGEX),
    blogListing,
    blogSample: recentBlogs[0] ?? null,
    caseStudies: caseStudyDetails[0] ?? caseStudyCandidates[0] ?? null,
    caseStudyDetails,
    testimonials: findBest(TESTIMONIAL_REGEX),
    faq: findBest(FAQ_REGEX),
    caseStudyCount: caseStudyDetails.length,
    blogPostsLast60Days,
    blogPostsLast90Days,
    blogPostsLast12Months,
    hasDatedBlogInventory: blogInventory.length > 0,
  };
}

interface BlogDetailEvidence {
  accepted: boolean;
  reason: "article_path" | "article_schema" | "no_article_path_or_schema";
  pathMatched: boolean;
  articleSchemaMatched: boolean;
  schemaTypes: string[];
}

function getBlogDetailEvidence(page: PageData): BlogDetailEvidence {
  try {
    const path = new URL(page.url).pathname.toLowerCase().replace(/\/$/, "");
    const pathMatched =
      /^\/(?:blog|blogs|articles|insights|resources|news|latest-news)\/[^/]+/.test(
        path,
      );
    const schemaTypes = extractSchemaTypes(page);
    const articleSchemaMatched = schemaTypes.some((type) =>
      /^(?:article|blogposting|newsarticle)$/i.test(type),
    );

    return {
      accepted: pathMatched || articleSchemaMatched,
      reason: pathMatched
        ? "article_path"
        : articleSchemaMatched
          ? "article_schema"
          : "no_article_path_or_schema",
      pathMatched,
      articleSchemaMatched,
      schemaTypes,
    };
  } catch {
    return {
      accepted: false,
      reason: "no_article_path_or_schema",
      pathMatched: false,
      articleSchemaMatched: false,
      schemaTypes: extractSchemaTypes(page),
    };
  }
}

function isLikelyBlogDetailPage(page: PageData): boolean {
  if (page.blogListingEntries.length >= 2) return false;
  return getBlogDetailEvidence(page).accepted;
}

function isLikelyCaseStudyDetailPage(page: PageData): boolean {
  try {
    const path = new URL(page.url).pathname.toLowerCase().replace(/\/$/, "");
    if (
      /^\/(?:case-studies|case-study|success-stories|success-story|results|portfolio|work)\/[^/]+/.test(
        path,
      )
    ) {
      return true;
    }

    return (
      /\bcase study\b/i.test([page.title, ...page.h1Tags].join(" ")) &&
      !/^\/(?:case-studies|case-study|success-stories|success-story|results|portfolio|work)$/.test(
        path,
      )
    );
  } catch {
    return false;
  }
}

function isRecentWithinDays(value: string | null, days: number): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const ageMs = Date.now() - parsed;
  return ageMs >= 0 && ageMs <= days * 24 * 60 * 60 * 1000;
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
    email_capture_evidence: page.emailCaptureEvidence,
    word_count: page.wordCount,
    list_count: page.unorderedListCount + page.orderedListCount,
    table_count: page.tableCount,
    blockquote_count: page.blockquoteCount,
    outbound_domains: extractOutboundDomains(page),
    schemas_detected: extractSchemaTypes(page),
    date_published: page.datePublished,
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
  robots: RobotsMeta,
  layer1?: Layer1Signals,
): Payload {
  const q2 = calcQ2(pages, robots, layer1);
  const q3 = calcQ3(pages);
  const q17 = calcQ17(pages, layer1);
  const q18 = calcQ18(pages, layer1);
  const selected = pickBestPages(pages);
  const siteSummary = buildSiteSummary(pages);
  const homepage = trimPage(selected.homepage ?? null, 1500);
  const about = trimPage(selected.about, 1500);
  const services = trimPage(selected.services, 1500);
  const contact = trimPage(selected.contact, 1500);
  const blogListing = trimPage(selected.blogListing, 600);
  const blogSample = trimPage(selected.blogSample, 2000);
  const caseStudies = trimPage(selected.caseStudies, 1500);
  const caseStudySamples = selected.caseStudyDetails
    .slice(0, 3)
    .map((page) => trimPage(page, 1500))
    .filter((page): page is TrimmedPage => Boolean(page));
  const testimonials = trimPage(selected.testimonials, 1500);
  const faq = trimPage(selected.faq, 1500);

  const schemaTypes = [
    ...new Set(pages.flatMap((page) => extractSchemaTypes(page))),
  ].slice(0, 40);
  const emailCapturePages = pages.filter((page) => page.hasEmailForm);
  const emailSequenceEvidence = emailCapturePages.some((page) =>
    /\b(?:email sequence|email series|nurture sequence|nurture emails?|email course|check your (?:email|inbox)|sent to your inbox|weekly newsletter|daily emails?)\b/i.test(
      page.bodyText,
    ),
  );
  const hasEmailCaptureEvidence = emailCapturePages.length > 0;

  console.log("[claude][q15] email evidence summary", {
    totalCrawledPages: pages.length,
    emailCapturePageCount: emailCapturePages.length,
    emailSequenceEvidence,
    pages: emailCapturePages.map((page) => ({
      url: page.url,
      title: page.title,
      hasForm: page.hasForm,
      hasEmailForm: page.hasEmailForm,
      emailCaptureEvidence: page.emailCaptureEvidence,
    })),
    q15EvidenceStatus: hasEmailCaptureEvidence ? "verified" : "unknown",
    deterministicScore: hasEmailCaptureEvidence
      ? emailSequenceEvidence
        ? 2
        : 1
      : null,
  });
  const leadMagnetEvidence = pages.some((page) => {
    const content = [
      page.title,
      page.metaDescription,
      ...page.h1Tags,
      ...page.h2Tags,
      ...page.ctaTexts,
      page.bodyText,
    ].join(" ");

    return (
      /\b(?:get|claim|download|access|take|start|free)\b[\s\S]{0,80}\b(?:visibility score|scorecard|guide|ebook|assessment|quiz|diagnostic|checklist|template|report)\b/i.test(
        content,
      ) ||
      /\b(?:free|downloadable)\s+(?:guide|ebook|assessment|quiz|scorecard|diagnostic|checklist|template|report)\b/i.test(
        content,
      )
    );
  });
  const hasBlogCadenceEvidence = selected.hasDatedBlogInventory;
  const hasCaseStudyNarrativeCoverage = caseStudySamples.length >= 2;
  const hasSecondaryContent = Boolean(
    selected.about || selected.services || selected.blogSample,
  );
  const q3EvidenceStatus = q3.evidence_status ?? "verified";
  const q17EvidenceStatus = q17.evidence_status ?? "verified";
  const q18EvidenceStatus = q18.evidence_status ?? "verified";
  const questionEvidence: Record<string, QuestionEvidence> = {
    q1: {
      status: selected.homepage && hasSecondaryContent ? "verified" : "unknown",
      reason:
        selected.homepage && hasSecondaryContent
          ? "Homepage and supporting key-page content were captured."
          : "Enough key-page content was not captured to verify this signal.",
    },
    q2: {
      status: q2.evidence_status ?? "verified",
      reason:
        q2.evidence_status === "unknown"
          ? "One or more technical checks were unavailable, so failure was not verified."
          : "The required technical checks completed.",
    },
    q3: {
      status: q3EvidenceStatus,
      reason:
        q3EvidenceStatus === "verified"
          ? "A supported analytics tag was positively detected."
          : "No supported analytics tag was visible in the captured markup; absence was not proven.",
    },
    q4: {
      status: hasBlogCadenceEvidence ? "verified" : "unknown",
      reason: hasBlogCadenceEvidence
        ? "Dated blog inventory was captured from the listing or verified detail pages."
        : "The crawl did not capture enough dated blog inventory to assess publishing cadence.",
    },
    q5: {
      status: selected.homepage && hasSecondaryContent ? "verified" : "unknown",
      reason:
        selected.homepage && hasSecondaryContent
          ? "Multiple relevant content pages were captured."
          : "Too little content was captured to assess site-wide buyer-question coverage.",
    },
    q6: {
      status: selected.homepage && hasSecondaryContent ? "verified" : "unknown",
      reason:
        selected.homepage && hasSecondaryContent
          ? "Multiple relevant pages were captured for structure analysis."
          : "Too little page content was captured to assess site-wide structure.",
    },
    q7: {
      status: selected.testimonials ? "verified" : "unknown",
      reason: selected.testimonials
        ? "A testimonials/reviews page was captured."
        : "A testimonials source was not captured, so absence was not proven.",
    },
    q8: {
      status: hasCaseStudyNarrativeCoverage ? "verified" : "unknown",
      reason: hasCaseStudyNarrativeCoverage
        ? "Multiple case-study detail pages were captured for narrative review."
        : "Multiple case-study narratives were not captured, so completeness or absence cannot be asserted.",
    },
    q9: {
      status: selected.about ? "verified" : "unknown",
      reason: selected.about
        ? "An About page was captured."
        : "An About page was not captured, so absence was not proven.",
    },
    q11: {
      status:
        selected.homepage && selected.about && selected.services
          ? "verified"
          : "unknown",
      reason:
        selected.homepage && selected.about && selected.services
          ? "Homepage, About, and Services pages were captured."
          : "The required cross-page set was incomplete.",
    },
    q13: {
      status: leadMagnetEvidence ? "verified" : "unknown",
      reason:
        leadMagnetEvidence
          ? "A visible lead-magnet offer or CTA was positively detected."
          : "Lead-magnet presence and alignment could not be verified from the captured pages.",
    },
    q14: {
      status: selected.homepage && selected.services ? "verified" : "unknown",
      reason:
        selected.homepage && selected.services
          ? "Homepage and Services CTA evidence was captured."
          : "Key-page CTA coverage was incomplete.",
    },
    q15: {
      status: hasEmailCaptureEvidence ? "verified" : "unknown",
      reason: hasEmailCaptureEvidence
        ? emailSequenceEvidence
          ? "Email capture and a specific public email follow-up path were detected."
          : "Email capture was positively detected, but no specific nurture sequence was visible."
        : "No email capture was found in the pages captured by the crawl, so site-wide absence was not proven.",
    },
    q16: {
      status: selected.services || selected.blogSample ? "verified" : "unknown",
      reason:
        selected.services || selected.blogSample
          ? "Substantive service or blog content was captured for citation review."
          : "Substantive content pages were not captured for citation review.",
    },
    q17: {
      status: q17EvidenceStatus,
      reason:
        q17EvidenceStatus === "verified"
          ? "Social profile links were positively detected."
          : "No social links were captured, but site-wide absence was not proven.",
    },
    q18: {
      status: q18EvidenceStatus,
      reason:
        q18EvidenceStatus === "verified"
          ? "At least one reliable content date was captured."
          : "No reliable content dates were captured.",
    },
  };

  return {
    url: selected.homepage?.url ?? pages[0]?.url ?? "",
    layer1_signals: {
      schemas_detected: schemaTypes,
      social_profiles: siteSummary.social_profiles,
      ga4_detected: pages.some((page) => Boolean(page.ga4Id)) || null,
      google_tag_detected:
        pages.some((page) => Boolean(page.googleTagId)) || null,
      gtm_detected: pages.some((page) => Boolean(page.gtmId)) || null,
      pagespeed_mobile: layer1?.performance.pageSpeedScore ?? null,
      forms_detected:
        pages.some((page) => page.hasForm)
          ? pages.filter((page) => page.hasForm).length
          : null,
      forms_with_email:
        hasEmailCaptureEvidence
          ? (layer1?.conversion.totalFormsWithEmail ??
            emailCapturePages.length)
          : null,
      email_capture_detected: hasEmailCaptureEvidence,
      email_sequence_evidence: emailSequenceEvidence,
      blog_posts_last_60_days: hasBlogCadenceEvidence
        ? selected.blogPostsLast60Days
        : null,
      blog_posts_last_90_days: hasBlogCadenceEvidence
        ? selected.blogPostsLast90Days
        : null,
      blog_posts_last_12_months: hasBlogCadenceEvidence
        ? selected.blogPostsLast12Months
        : null,
      blog_listing_title: selected.blogListing?.title ?? null,
      recent_blog_sample_captured: Boolean(selected.blogSample),
      case_study_count:
        selected.caseStudyCount > 0 ? selected.caseStudyCount : null,
      person_schema_on_about: hasPersonSchema(selected.about),
      review_schema_present: pages.some(
        (page) => page.schemaSignals.reviewOrAggregateRating,
      ),
      q2_score: q2.score,
      q3_score: q3.score,
      q17_score: q17.score,
      q18_score: q18.score,
    },
    question_evidence: questionEvidence,
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
      blog_listing: blogListing,
      blog_sample: blogSample,
      case_studies: caseStudies,
      case_study_samples: caseStudySamples,
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
    (typeof fix.pillar === "string" || typeof fix.pillar === "undefined") &&
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

  if (!Array.isArray(obj.priority_fixes)) {
    throw new Error("Missing priority_fixes");
  }

  const priorityFixes = obj.priority_fixes
    .filter(isValidPriorityFix)
    .map(normalizePriorityFix);
  if (priorityFixes.length !== obj.priority_fixes.length) {
    throw new Error("Invalid priority_fixes entries");
  }

  return {
    business_name: obj.business_name.trim(),
    scores,
    priority_fixes: priorityFixes.slice(0, 5),
  };
}

export function applyEvidencePolicy(
  response: ClaudeSuccessResponse,
  payload: Payload,
): ClaudeSuccessResponse {
  const scores = { ...response.scores };

  for (const questionId of CLAUDE_QUESTION_IDS) {
    const evidence = payload.question_evidence[questionId];
    const current = scores[questionId];
    if (!evidence || !current) continue;

    scores[questionId] =
      evidence.status === "unknown"
        ? {
            score: 1,
            reasoning: evidence.reason,
            evidence_status: "unknown",
          }
        : {
            ...current,
            evidence_status: "verified",
          };
  }

  if (payload.layer1_signals.email_capture_detected) {
    scores.q15 = payload.layer1_signals.email_sequence_evidence
      ? {
          score: 2,
          reasoning:
            "Email capture and a specific public email follow-up path were detected.",
          evidence_status: "verified",
        }
      : {
          score: 1,
          reasoning:
            "Email capture was detected, but no specific email sequence or nurture path was visible.",
          evidence_status: "verified",
        };
  }

  const q4Last60Days = payload.layer1_signals.blog_posts_last_60_days;
  if (
    payload.question_evidence.q4?.status === "verified" &&
    scores.q4.score === 2 &&
    (q4Last60Days === null ||
      q4Last60Days < 2 ||
      !payload.layer1_signals.recent_blog_sample_captured)
  ) {
    scores.q4 = {
      score: 1,
      reasoning:
        "Dated blog activity was verified, but the evidence did not include both two posts in the last 60 days and a captured substantive sample.",
      evidence_status: "verified",
    };
  }

  const effectiveScores: Record<string, number> = {
    ...Object.fromEntries(
      Object.entries(scores).map(([question, result]) => [
        question,
        result.score,
      ]),
    ),
    q2: payload.layer1_signals.q2_score,
    q3: payload.layer1_signals.q3_score,
    q17: payload.layer1_signals.q17_score,
    q18: payload.layer1_signals.q18_score,
  };

  const eligibleFixRefs = Object.entries(effectiveScores)
    .filter(([questionRef, score]) => {
      const evidence = payload.question_evidence[questionRef];
      return evidence?.status === "verified" && score < 2;
    })
    .sort(([questionA, scoreA], [questionB, scoreB]) => {
      const pillarA = QUESTION_TO_PILLAR[questionA] ?? "unknown";
      const pillarB = QUESTION_TO_PILLAR[questionB] ?? "unknown";
      const impactA = (2 - scoreA) * (PILLAR_FIX_WEIGHTS[pillarA] ?? 0);
      const impactB = (2 - scoreB) * (PILLAR_FIX_WEIGHTS[pillarB] ?? 0);
      return impactB - impactA;
    })
    .map(([questionRef]) => questionRef);

  const proposedFixesByQuestion = new Map<string, PriorityFix>();
  for (const fix of response.priority_fixes) {
    if (
      eligibleFixRefs.includes(fix.question_ref) &&
      !proposedFixesByQuestion.has(fix.question_ref)
    ) {
      proposedFixesByQuestion.set(fix.question_ref, fix);
    }
  }

  const priorityFixes = eligibleFixRefs
    .map((questionRef) => {
      const proposed = proposedFixesByQuestion.get(questionRef);
      if (proposed) return proposed;

      const fallback = VERIFIED_FALLBACK_FIXES[questionRef];
      if (!fallback) return null;

      return {
        rank: 0,
        question_ref: questionRef,
        pillar: QUESTION_TO_PILLAR[questionRef] ?? "unknown",
        ...fallback,
      };
    })
    .filter((fix): fix is PriorityFix => Boolean(fix))
    .slice(0, 5)
    .map((fix, index) => ({
      ...fix,
      rank: index + 1,
      pillar: QUESTION_TO_PILLAR[fix.question_ref] ?? fix.pillar,
    }));

  return {
    ...response,
    scores,
    priority_fixes: priorityFixes,
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
      const validated = validateClaudeResponse(parsed);
      const governed = applyEvidencePolicy(validated, payload);
      console.log("[claude] priority fix evidence policy", {
        proposed: validated.priority_fixes.map((fix) => fix.question_ref),
        returned: governed.priority_fixes.map((fix) => fix.question_ref),
        backfilled: governed.priority_fixes
          .filter(
            (fix) =>
              !validated.priority_fixes.some(
                (proposed) => proposed.question_ref === fix.question_ref,
              ),
          )
          .map((fix) => fix.question_ref),
      });
      return governed;
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

export function buildDebugPayload(
  pages: PageData[],
  robots: RobotsMeta,
  layer1?: Layer1Signals,
): {
  selectedPages: {
    homepage: PageData | undefined;
    about: PageData | null;
    services: PageData | null;
    contact: PageData | null;
    blogListing: PageData | null;
    blogSample: PageData | null;
    caseStudies: PageData | null;
    testimonials: PageData | null;
    faq: PageData | null;
  };
  trimmedPayload: Payload;
  promptText: string;
} {
  const selected = pickBestPages(pages);
  const trimmedPayload = buildPayload(pages, robots, layer1);

  return {
    selectedPages: {
      homepage: selected.homepage,
      about: selected.about,
      services: selected.services,
      contact: selected.contact,
      blogListing: selected.blogListing,
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
  robots: RobotsMeta,
  layer1?: Layer1Signals,
): Promise<ClaudeResponse> {
  const payload = buildPayload(pages, robots, layer1);
  return requestClaudeAnalysis(payload);
}
