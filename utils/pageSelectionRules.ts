export const PAGE_TYPE_RULES = {
  about: {
    navTexts: ["about", "about us", "our story", "team"],
    slugs: ["/about", "/about-us", "/team", "/our-story"],
  },
  services: {
    navTexts: [
      "services",
      "products",
      "solutions",
      "what we do",
      "how we help",
    ],
    slugs: [
      "/services",
      "/service",
      "/products",
      "/solutions",
      "/what-we-do",
      "/how-we-help",
    ],
  },
  blog: {
    navTexts: ["blog", "articles", "insights", "resources", "news", "latest"],
    slugs: [
      "/blog",
      "/articles",
      "/insights",
      "/resources",
      "/news",
      "/latest-news",
    ],
  },
  caseStudies: {
    navTexts: [
      "case studies",
      "success stories",
      "results",
      "portfolio",
      "work",
    ],
    slugs: [
      "/case-studies",
      "/success-stories",
      "/results",
      "/work",
      "/portfolio",
    ],
  },
  testimonials: {
    navTexts: ["testimonials", "reviews"],
    slugs: ["/testimonials", "/reviews"],
  },
} as const;

export function buildCloudflareIncludePatterns(startUrl: string): string[] {
  const { origin } = new URL(startUrl);
  const patterns = new Set<string>([startUrl, `${origin}/`, origin]);

  Object.values(PAGE_TYPE_RULES)
    .flatMap((rule) => rule.slugs)
    .forEach((slug) => {
      patterns.add(`${origin}${slug}`);
      patterns.add(`${origin}${slug}/`);
      patterns.add(`${origin}${slug}/**`);
    });

  return [...patterns];
}

export function buildCloudflareExcludePatterns(startUrl: string): string[] {
  const { origin } = new URL(startUrl);

  return [
    `${origin}/tag/**`,
    `${origin}/category/**`,
    `${origin}/author/**`,
    `${origin}/feed/**`,
    `${origin}/wp-json/**`,
    `${origin}/wp-admin/**`,
    `${origin}/page/**`,
  ];
}
