import axios from "axios";
import type { RobotsMeta } from "./types";

const ROBOTS_TIMEOUT_MS = 5000;
const CRAWL_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
};

interface RobotsGroup {
  userAgents: string[];
  rules: string[];
}

function unavailableRobotsMeta(): RobotsMeta {
  return {
    gptBotAllowed: null,
    claudeBotAllowed: null,
    perplexityBotAllowed: null,
  };
}

/**
 * Parses robots.txt into user-agent groups while preserving grouped directives.
 */
function parseRobotsGroups(robotsTxt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;

    const idx = line.indexOf(":");
    if (idx === -1) continue;

    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line
      .slice(idx + 1)
      .trim()
      .toLowerCase();
    if (!value) continue;

    if (field === "user-agent") {
      if (!current || current.rules.length > 0) {
        current = { userAgents: [], rules: [] };
        groups.push(current);
      }
      current.userAgents.push(value);
      continue;
    }

    if (!current) continue;
    current.rules.push(`${field}: ${value}`);
  }

  return groups;
}

/**
 * Returns true only when the agent is explicitly blocked with `Disallow: /`.
 * Missing directives or narrower path disallows do not count as fully blocked.
 */
function isExplicitlyDisallowed(robotsTxt: string, botName: string): boolean {
  const bot = botName.toLowerCase();
  const groups = parseRobotsGroups(robotsTxt);

  const relevantGroups = groups.filter(
    (group) => group.userAgents.includes(bot) || group.userAgents.includes("*"),
  );

  for (const group of relevantGroups) {
    const exactAgentMatch = group.userAgents.includes(bot);
    const wildcardMatch = !exactAgentMatch && group.userAgents.includes("*");
    if (!exactAgentMatch && !wildcardMatch) continue;

    const allowAll = group.rules.some((rule) => /^allow:\s*\/$/i.test(rule));
    const disallowAll = group.rules.some((rule) =>
      /^disallow:\s*\/(?:\s|$)/i.test(rule),
    );

    if (disallowAll && !allowAll) return true;
  }

  return false;
}

export async function fetchRobotsMeta(baseUrl: string): Promise<RobotsMeta> {
  try {
    const { origin } = new URL(baseUrl);
    const robotsUrl = `${origin}/robots.txt`;
    const response = await axios.get<string>(robotsUrl, {
      timeout: ROBOTS_TIMEOUT_MS,
      headers: CRAWL_HEADERS,
      validateStatus: () => true,
    });

    const contentType = response.headers["content-type"];
    const isHtmlResponse =
      typeof contentType === "string" &&
      contentType.toLowerCase().includes("text/html");

    if (
      response.status < 200 ||
      response.status >= 300 ||
      isHtmlResponse
    ) {
      console.warn("[robots] unavailable", {
        url: robotsUrl,
        status: response.status,
        contentType: contentType ?? null,
        siteGroundCaptcha: response.headers["sg-captcha"] ?? null,
      });
      return unavailableRobotsMeta();
    }

    return {
      gptBotAllowed: !isExplicitlyDisallowed(response.data, "GPTBot"),
      claudeBotAllowed: !isExplicitlyDisallowed(
        response.data,
        "ClaudeBot",
      ),
      perplexityBotAllowed: !isExplicitlyDisallowed(
        response.data,
        "PerplexityBot",
      ),
    };
  } catch (err) {
    console.warn("[robots] request failed", {
      url: baseUrl,
      message: err instanceof Error ? err.message : "Unknown error",
    });
    return unavailableRobotsMeta();
  }
}
