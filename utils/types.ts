export interface SocialProfiles {
  linkedin: string[];
  facebook: string[];
  instagram: string[];
  x: string[];
  youtube: string[];
  tiktok: string[];
  pinterest: string[];
}

export interface SchemaSignals {
  faq: boolean;
  productOrService: boolean;
  localBusinessOrOrganization: boolean;
  reviewOrAggregateRating: boolean;
}

export interface PageData {
  url: string;
  // ── Core content (Claude prompt inputs) ──────────────────────────────────
  title: string;
  metaDescription: string;
  h1Tags: string[];
  h2Tags: string[];
  bodyText: string;
  schemas: string[];
  outboundLinks: string[];
  // ── Scoring signals ───────────────────────────────────────────────────────
  isJSSite: boolean;
  ga4Id: string | null;
  gtmId: string | null;
  businessName: string;
  hasForm: boolean;
  ctaTexts: string[];
  wordCount: number;
  unorderedListCount: number;
  orderedListCount: number;
  tableCount: number;
  blockquoteCount: number;
  socialProfiles: SocialProfiles;
  schemaSignals: SchemaSignals;
  dateModified: string | null;
}

export type ErrorType =
  | "timeout"
  | "blocked"
  | "not_found"
  | "server_error"
  | "parse_error"
  | "unknown";

export interface CrawlError {
  url: string;
  type: ErrorType;
  message: string;
}

export interface RobotsMeta {
  gptBotAllowed: boolean | null;
  claudeBotAllowed: boolean | null;
  perplexityBotAllowed: boolean | null;
}

// Minimal handler interface — structurally compatible with both
// Vercel's VercelRequest and Express's Request.
export interface ApiRequest {
  method?: string;
  body: unknown;
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: {
    remoteAddress?: string;
  };
}

// Minimal handler interface — structurally compatible with both
// Vercel's VercelResponse and Express's Response.
export interface ApiResponse {
  status(code: number): ApiResponse;
  json(data: unknown): unknown;
}
