import * as cheerio from "cheerio";
import type {
  BlogListingEntry,
  PageData,
  SchemaSignals,
  SocialProfiles,
} from "./types";

const GA4_PATTERN = /\bG-[A-Z0-9]{4,}\b/i;
const GOOGLE_TAG_PATTERN = /\bGT-[A-Z0-9]{4,}\b/i;
const GTM_PATTERN = /\bGTM-[A-Z0-9]{4,}\b/i;
const EMAIL_CAPTURE_EMBED_PATTERNS: Array<{
  pattern: RegExp;
  provider: string;
}> = [
  {
    pattern:
      /(?:leadconnectorhq\.com|leadconnectorhq\.io|msgsndr\.com|links\.gohighlevel\.com|forms\.gohighlevel\.com)/i,
    provider: "GoHighLevel/LeadConnector embed",
  },
  {
    pattern: /(?:hubspot\.com|hsforms\.net|js\.hsforms\.net)/i,
    provider: "HubSpot form embed",
  },
  {
    pattern: /(?:convertkit\.com|kit\.com|ck\.page)/i,
    provider: "Kit/ConvertKit form embed",
  },
  {
    pattern: /(?:mailchimp\.com|list-manage\.com)/i,
    provider: "Mailchimp form embed",
  },
  {
    pattern: /(?:typeform\.com|tally\.so|jotform\.com)/i,
    provider: "third-party form embed",
  },
];

const CTA_KEYWORDS = [
  "contact",
  "book",
  "get started",
  "sign up",
  "schedule",
  "free trial",
  "try now",
  "buy now",
  "request",
  "demo",
];

interface SiteAnalysis {
  needsJs: boolean;
  confidence: "high" | "medium" | "low";
  reasons: string[];
}

function emptySocialProfiles(): SocialProfiles {
  return {
    linkedin: [],
    facebook: [],
    instagram: [],
    x: [],
    youtube: [],
    tiktok: [],
    pinterest: [],
  };
}

function parseJsonLike(value: string): unknown[] {
  const parsed: unknown[] = [];

  try {
    parsed.push(JSON.parse(value));
    return parsed;
  } catch {
    // Some sites concatenate multiple JSON objects in one script block.
  }

  for (const part of value.split(/\n\s*\n/)) {
    try {
      parsed.push(JSON.parse(part));
    } catch {
      // Ignore malformed fragments.
    }
  }

  return parsed;
}

function walkJson(
  node: unknown,
  visit: (value: Record<string, unknown>) => void,
): void {
  if (Array.isArray(node)) {
    node.forEach((item) => walkJson(item, visit));
    return;
  }

  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    visit(obj);
    Object.values(obj).forEach((value) => walkJson(value, visit));
  }
}

function coerceIsoDate(value: string): string | null {
  const normalized = value.trim().replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1");
  const parseValue = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? `${normalized}T00:00:00.000Z`
    : VISIBLE_CONTENT_DATE_PATTERN.test(normalized)
      ? `${normalized} UTC`
      : normalized;
  const t = Date.parse(parseValue);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function pickLatestIsoDate(
  ...values: Array<string | null | undefined>
): string | null {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null
  );
}

const VISIBLE_CONTENT_DATE_PATTERN =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+20\d{2}\b/i;

function extractBlogListingEntries(
  $: cheerio.CheerioAPI,
  pageUrl: string,
): BlogListingEntry[] {
  const page = new URL(pageUrl);
  const pageHost = page.hostname.replace(/^www\./, "");
  const pageCanonical = pageUrl.replace(/\/+$/, "");
  const entries = new Map<string, BlogListingEntry>();
  const cardSelector = [
    "article",
    "[class*='elementor-post']",
    "[class*='post-card']",
    "[class*='post-item']",
    "[class*='blog-card']",
    "[class*='blog-item']",
    "[class*='article-card']",
    "[class*='article-item']",
    ".e-loop-item",
    ".type-post",
  ].join(", ");

  $(cardSelector).each((_, element) => {
    const card = $(element);
    const cardText = (card.html() ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    const rawDate =
      card.find("time[datetime]").first().attr("datetime") ||
      card.find("[itemprop='datePublished'][content]").first().attr("content") ||
      cardText.match(VISIBLE_CONTENT_DATE_PATTERN)?.[0];
    const datePublished = rawDate ? coerceIsoDate(rawDate) : null;
    if (!datePublished) return;

    const headingLink = card
      .find("h1 a[href], h2 a[href], h3 a[href], h4 a[href]")
      .first();
    const link = headingLink.length > 0 ? headingLink : card.find("a[href]").first();
    const href = link.attr("href");
    if (!href) return;

    try {
      const resolved = new URL(href, pageUrl);
      const host = resolved.hostname.replace(/^www\./, "");
      if (host !== pageHost || !["http:", "https:"].includes(resolved.protocol)) {
        return;
      }
      if (
        /\/(?:tag|category|author|page|feed|wp-json|wp-admin)(?:\/|$)/i.test(
          resolved.pathname,
        )
      ) {
        return;
      }

      resolved.hash = "";
      const canonical = resolved.toString().replace(/\/+$/, "");
      if (canonical === pageCanonical) return;

      const headingText = card
        .find("h1, h2, h3, h4")
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim();
      const title = (headingText || link.text()).replace(/\s+/g, " ").trim();
      if (title.length < 4) return;

      const existing = entries.get(canonical);
      if (!existing || datePublished > existing.datePublished) {
        entries.set(canonical, {
          url: resolved.toString(),
          title,
          datePublished,
        });
      }
    } catch {
      // Ignore malformed card links.
    }
  });

  return [...entries.values()].sort((a, b) =>
    b.datePublished.localeCompare(a.datePublished),
  );
}

function extractSchemaSignals(schemas: string[]): {
  schemaSignals: SchemaSignals;
  datePublished: string | null;
  dateModified: string | null;
} {
  const detectedTypes = new Set<string>();
  let latestDatePublished: string | null = null;
  let latestDateModified: string | null = null;

  for (const raw of schemas) {
    for (const parsed of parseJsonLike(raw)) {
      walkJson(parsed, (obj) => {
        const atType = obj["@type"];
        const values = Array.isArray(atType) ? atType : atType ? [atType] : [];

        values.forEach((value) => {
          if (typeof value === "string") {
            detectedTypes.add(value.toLowerCase());
          }
        });

        if (typeof obj.datePublished === "string") {
          const iso = coerceIsoDate(obj.datePublished);
          if (iso && (!latestDatePublished || iso > latestDatePublished)) {
            latestDatePublished = iso;
          }
        }
        if (typeof obj.dateModified === "string") {
          const iso = coerceIsoDate(obj.dateModified);
          if (iso && (!latestDateModified || iso > latestDateModified)) {
            latestDateModified = iso;
          }
        }
      });
    }
  }

  const types = [...detectedTypes];
  return {
    schemaSignals: {
      faq: types.some((type) => type.includes("faq")),
      productOrService: types.some(
        (type) => type.includes("product") || type.includes("service"),
      ),
      localBusinessOrOrganization: types.some(
        (type) =>
          type.includes("localbusiness") || type.includes("organization"),
      ),
      reviewOrAggregateRating: types.some(
        (type) => type.includes("review") || type.includes("aggregaterating"),
      ),
    },
    datePublished: latestDatePublished,
    dateModified: latestDateModified,
  };
}

function analyzeHtmlNeedsJs(html: string): SiteAnalysis {
  const reasons: string[] = [];
  let jsSignals = 0;

  const lower = html.toLowerCase();

  // ── Signal 1: Tiny HTML document (JS renders real content) ──────────────
  if (html.length < 1500) {
    jsSignals++;
    reasons.push(`Very small HTML (${html.length} chars) — likely a JS shell`);
  }

  // ── Signal 2: Empty or near-empty body tag ───────────────────────────────
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyContent = bodyMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  if (bodyContent.length < 200) {
    jsSignals++;
    reasons.push(
      `Empty body (${bodyContent.length} chars) — content loaded by JS`,
    );
  }

  // ── Signal 3: Known framework root divs ──────────────────────────────────
  const jsRootPatterns: Array<{ pattern: string; framework: string }> = [
    { pattern: 'id="root"', framework: "React" },
    { pattern: 'id="app"', framework: "Vue/React" },
    { pattern: 'id="__next"', framework: "Next.js" },
    { pattern: 'id="__nuxt"', framework: "Nuxt.js" },
    { pattern: 'id="gatsby-focus-wrapper"', framework: "Gatsby" },
    { pattern: "ng-version", framework: "Angular" },
    { pattern: "data-reactroot", framework: "React SSR partial" },
    { pattern: "data-server-rendered", framework: "Vue SSR" },
  ];

  for (const { pattern, framework } of jsRootPatterns) {
    if (lower.includes(pattern)) {
      jsSignals++;
      reasons.push(`Found ${framework} mount point: ${pattern}`);
      break;
    }
  }

  // ── Signal 4: No meaningful readable text ────────────────────────────────
  const textContent = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (textContent.length < 300) {
    jsSignals++;
    reasons.push(
      `Almost no readable text after stripping tags (${textContent.length} chars)`,
    );
  }

  // ── Signal 5: Heavy JS bundle references ─────────────────────────────────
  const scriptMatches = html.match(/<script[^>]+src=[^>]+>/gi) ?? [];
  const heavyBundles = scriptMatches.filter((s) => {
    const l = s.toLowerCase();
    return (
      l.includes("chunk") ||
      l.includes("bundle") ||
      l.includes("main.") ||
      l.includes("app.") ||
      l.includes("vendor.")
    );
  });

  if (heavyBundles.length >= 2) {
    jsSignals++;
    reasons.push(`${heavyBundles.length} JS bundle files found — SPA pattern`);
  }

  // ── Signal 6: Explicit noscript fallback ─────────────────────────────────
  if (lower.includes("<noscript>") && lower.includes("enable javascript")) {
    jsSignals++;
    reasons.push("Has <noscript> block asking user to enable JS");
  }

  // ── Signal 7: Meta/framework hints ───────────────────────────────────────
  const metaFrameworks = [
    "next.js",
    "nuxt",
    "gatsby",
    "remix",
    "vite",
    "create-react-app",
  ];
  for (const fw of metaFrameworks) {
    if (lower.includes(fw)) {
      jsSignals++;
      reasons.push(`Meta tag/comment references ${fw}`);
      break;
    }
  }

  const needsJs = jsSignals >= 2;
  const confidence: "high" | "medium" | "low" =
    jsSignals >= 4 ? "high" : jsSignals >= 2 ? "medium" : "low";

  return { needsJs, confidence, reasons };
}

export function parseHTML(
  html: string,
  url: string,
  metadata?: {
    httpLastModified?: string | null;
    sitemapLastmod?: string | null;
  },
): PageData {
  const $ = cheerio.load(html);

  // ── 1. Title ──────────────────────────────────────────────────────────────
  const title = $("title").text().trim();

  // ── 2. Meta description ───────────────────────────────────────────────────
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ?? "";

  // ── 3. Heading structure (H1 + H2 + H3) ───────────────────────────────────
  const h1Tags: string[] = [];
  $("h1").each((_, el) => {
    h1Tags.push($(el).text().trim());
  });

  const h2Tags: string[] = [];
  $("h2").each((_, el) => {
    h2Tags.push($(el).text().trim());
  });

  const h3Tags: string[] = [];
  $("h3").each((_, el) => {
    h3Tags.push($(el).text().trim());
  });

  // ── 5. Schema markup — extracted BEFORE scripts are removed ─────────────
  // Must run first: $("script").remove() below would wipe these nodes.
  const schemas: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const content = $(el).html()?.trim();
    if (content) schemas.push(content);
  });

  // ── 4. Full page body text (script/style stripped) ────────────────────────
  $("script, style, noscript").remove();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  // ── 6. Outbound links (external domains only) ─────────────────────────────
  const { hostname } = new URL(url);
  const baseHost = hostname.replace(/^www\./, "");
  const seenOutbound = new Set<string>();
  const outboundLinks: string[] = [];
  const socialProfiles = emptySocialProfiles();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const resolved = new URL(href, url);
      if (!["http:", "https:"].includes(resolved.protocol)) return;
      const linkHost = resolved.hostname.replace(/^www\./, "");
      // Skip internal and subdomain links
      if (linkHost === baseHost || linkHost.endsWith(`.${baseHost}`)) return;
      if (seenOutbound.has(resolved.href)) return;
      seenOutbound.add(resolved.href);
      outboundLinks.push(resolved.href);

      const normalized = resolved.href.toLowerCase();
      if (normalized.includes("linkedin.com/")) {
        socialProfiles.linkedin.push(resolved.href);
      } else if (normalized.includes("facebook.com/")) {
        socialProfiles.facebook.push(resolved.href);
      } else if (normalized.includes("instagram.com/")) {
        socialProfiles.instagram.push(resolved.href);
      } else if (normalized.includes("x.com/") || normalized.includes("twitter.com/")) {
        socialProfiles.x.push(resolved.href);
      } else if (normalized.includes("youtube.com/") || normalized.includes("youtu.be/")) {
        socialProfiles.youtube.push(resolved.href);
      } else if (normalized.includes("tiktok.com/")) {
        socialProfiles.tiktok.push(resolved.href);
      } else if (normalized.includes("pinterest.com/")) {
        socialProfiles.pinterest.push(resolved.href);
      }
    } catch {
      // Malformed href — skip
    }
  });

  // ── JS-site detection ─────────────────────────────────────────────────────
  // Detect likely SPA shells / JS-rendered sites using multiple independent
  // signals from the raw HTML.
  const jsAnalysis = analyzeHtmlNeedsJs(html);
  const isJSSite = jsAnalysis.needsJs;

  // ── GA4 ───────────────────────────────────────────────────────────────────
  const ga4Match = html.match(GA4_PATTERN);
  const ga4Id = ga4Match ? ga4Match[0].toUpperCase() : null;
  const googleTagMatch = html.match(GOOGLE_TAG_PATTERN);
  const googleTagId = googleTagMatch
    ? googleTagMatch[0].toUpperCase()
    : null;
  const gtmMatch = html.match(GTM_PATTERN);
  const gtmId = gtmMatch ? gtmMatch[0].toUpperCase() : null;

  // ── Business name ─────────────────────────────────────────────────────────
  const businessName =
    $("meta[property='og:site_name']").attr("content")?.trim() ||
    title.split("|")[0]?.trim() ||
    "";

  // ── CTA + form signals ────────────────────────────────────────────────────
  const forms = $("form");
  const emailCaptureEvidence: string[] = [];
  const emailInputs = $(
    [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[id*="email" i]',
      'input[autocomplete="email" i]',
      'input[aria-label*="email" i]',
      'input[placeholder*="email" i]',
      'input[placeholder*="@"]',
    ].join(", "),
  );
  let hasEmailForm = emailInputs.length > 0;

  if (emailInputs.length > 0) {
    emailCaptureEvidence.push("native email input");
  }

  for (const { pattern, provider } of EMAIL_CAPTURE_EMBED_PATTERNS) {
    if (pattern.test(html)) {
      emailCaptureEvidence.push(provider);
    }
  }

  const uniqueEmailCaptureEvidence = [...new Set(emailCaptureEvidence)];
  if (uniqueEmailCaptureEvidence.length > 0) {
    hasEmailForm = true;
  }
  const hasForm =
    forms.length > 0 ||
    emailInputs.length > 0 ||
    uniqueEmailCaptureEvidence.length > 0;

  const ctaTexts: string[] = [];
  $("a, button").each((_, el) => {
    const text = $(el).text().trim().toLowerCase();
    if (text && CTA_KEYWORDS.some((kw) => text.includes(kw))) {
      ctaTexts.push($(el).text().trim());
    }
  });

  const {
    schemaSignals,
    datePublished: schemaDatePublished,
    dateModified: schemaDateModified,
  } = extractSchemaSignals(schemas);
  const httpLastModified =
    typeof metadata?.httpLastModified === "string"
      ? coerceIsoDate(metadata.httpLastModified)
      : null;
  const sitemapLastmod =
    typeof metadata?.sitemapLastmod === "string"
      ? coerceIsoDate(metadata.sitemapLastmod)
      : null;
  const metaPublished = [
    $("meta[property='article:published_time']").attr("content"),
    $("meta[name='article:published_time']").attr("content"),
  ]
    .filter((value): value is string => Boolean(value))
    .map(coerceIsoDate)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const metaModified = [
    $("meta[property='article:modified_time']").attr("content"),
    $("meta[name='article:modified_time']").attr("content"),
  ]
    .filter((value): value is string => Boolean(value))
    .map(coerceIsoDate)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const articleTime = $("article time[datetime], main time[datetime]")
    .map((_, el) => $(el).attr("datetime"))
    .get()
    .filter((value): value is string => Boolean(value))
    .map(coerceIsoDate)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const datePublished = pickLatestIsoDate(
    schemaDatePublished,
    metaPublished,
    articleTime,
  );
  const dateModified = pickLatestIsoDate(
    schemaDateModified,
    datePublished,
    httpLastModified,
    sitemapLastmod,
    metaModified,
  );
  const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;
  const debugSchemaTypes = [
    ...new Set(
      schemas.flatMap((schema) =>
        [...schema.matchAll(/"@type"\s*:\s*"([^"]+)"/gi)]
          .map((match) => match[1])
          .filter(Boolean),
      ),
    ),
  ];
  const looksLikeBlogContent =
    debugSchemaTypes.some((type) =>
      /^(?:article|blogposting|newsarticle)$/i.test(type),
    ) ||
    /\/(?:blog|blogs|post|posts|article|articles|insight|insights|news)(?:\/|$)/i.test(
      new URL(url).pathname,
    );
  const visibleDateTextMatches = [
    ...new Set(
      bodyText.match(
        /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+20\d{2}\b/gi,
      ) ?? [],
    ),
  ].slice(0, 20);
  const blogListingEntries = extractBlogListingEntries($, url);

  if (looksLikeBlogContent) {
    console.log("[parser][blog] date evidence", {
      url,
      title,
      schemaTypes: debugSchemaTypes.slice(0, 10),
      schemaDate: schemaDateModified,
      schemaDatePublished,
      httpLastModified,
      sitemapLastmod,
      metaPublished: metaPublished ?? null,
      metaModified: metaModified ?? null,
      articleTime: articleTime ?? null,
      selectedPublishedDate: datePublished,
      selectedDate: dateModified,
      visibleDateTextMatches,
      blogListingEntries: blogListingEntries.slice(0, 20),
      wordCount,
    });
  }

  return {
    url,
    title,
    metaDescription,
    h1Tags,
    h2Tags,
    h3Tags,
    bodyText,
    schemas,
    outboundLinks,
    isJSSite,
    ga4Id,
    googleTagId,
    gtmId,
    businessName,
    hasForm,
    hasEmailForm,
    emailCaptureEvidence: uniqueEmailCaptureEvidence,
    ctaTexts: [...new Set(ctaTexts)],
    wordCount,
    unorderedListCount: $("ul").length,
    orderedListCount: $("ol").length,
    tableCount: $("table").length,
    blockquoteCount: $("blockquote").length,
    socialProfiles: {
      linkedin: [...new Set(socialProfiles.linkedin)],
      facebook: [...new Set(socialProfiles.facebook)],
      instagram: [...new Set(socialProfiles.instagram)],
      x: [...new Set(socialProfiles.x)],
      youtube: [...new Set(socialProfiles.youtube)],
      tiktok: [...new Set(socialProfiles.tiktok)],
      pinterest: [...new Set(socialProfiles.pinterest)],
    },
    schemaSignals,
    datePublished,
    dateModified,
    blogListingEntries,
  };
}
