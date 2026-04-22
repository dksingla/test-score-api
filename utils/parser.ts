import * as cheerio from "cheerio";
import type { PageData } from "./types";

const GA4_PATTERN = /G-[A-Z0-9]{4,}/;

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

export function parseHTML(html: string, url: string): PageData {
  const $ = cheerio.load(html);

  // ── 1. Title ──────────────────────────────────────────────────────────────
  const title = $("title").text().trim();

  // ── 2. Meta description ───────────────────────────────────────────────────
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ?? "";

  // ── 3. Heading structure (H1 + H2) ────────────────────────────────────────
  const h1Tags: string[] = [];
  $("h1").each((_, el) => {
    h1Tags.push($(el).text().trim());
  });

  const h2Tags: string[] = [];
  $("h2").each((_, el) => {
    h2Tags.push($(el).text().trim());
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
  const ga4Id = ga4Match ? ga4Match[0] : null;

  // ── Business name ─────────────────────────────────────────────────────────
  const businessName =
    $("meta[property='og:site_name']").attr("content")?.trim() ||
    title.split("|")[0]?.trim() ||
    "";

  // ── CTA + form signals ────────────────────────────────────────────────────
  const hasForm = $("form").length > 0;

  const ctaTexts: string[] = [];
  $("a, button").each((_, el) => {
    const text = $(el).text().trim().toLowerCase();
    if (text && CTA_KEYWORDS.some((kw) => text.includes(kw))) {
      ctaTexts.push($(el).text().trim());
    }
  });

  return {
    url,
    title,
    metaDescription,
    h1Tags,
    h2Tags,
    bodyText,
    schemas,
    outboundLinks,
    isJSSite,
    ga4Id,
    businessName,
    hasForm,
    ctaTexts: [...new Set(ctaTexts)],
  };
}
