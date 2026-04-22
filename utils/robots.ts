import axios from "axios";
import type { RobotsMeta } from "./types";

const ROBOTS_TIMEOUT_MS = 5000;
const CRAWL_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; FireUpBot/1.0)",
};

/**
 * Extracts the rule block for a given agent starting at startIdx.
 * Stops at the next `user-agent:` directive or end of file.
 */
function extractAgentBlock(txt: string, startIdx: number): string {
  const from = txt.slice(startIdx);
  const nextAgent = from.indexOf("\nuser-agent:", 1);
  return nextAgent === -1 ? from : from.slice(0, nextAgent);
}

/**
 * Returns true when the given bot has `Disallow: /` in its rule block,
 * or falls back to the wildcard `*` block if no specific rule exists.
 */
function isDisallowedInRobots(robotsTxt: string, botName: string): boolean {
  const txt = robotsTxt.toLowerCase();
  const bot = botName.toLowerCase();

  const botIdx = txt.indexOf(`user-agent: ${bot}`);
  if (botIdx !== -1) {
    const block = extractAgentBlock(txt, botIdx);
    return block.includes("disallow: /");
  }

  const wildcardIdx = txt.indexOf("user-agent: *");
  if (wildcardIdx !== -1) {
    const block = extractAgentBlock(txt, wildcardIdx);
    return block.includes("disallow: /");
  }

  return false;
}

export async function fetchRobotsMeta(baseUrl: string): Promise<RobotsMeta> {
  try {
    const { origin } = new URL(baseUrl);
    const { data } = await axios.get<string>(`${origin}/robots.txt`, {
      timeout: ROBOTS_TIMEOUT_MS,
      headers: CRAWL_HEADERS,
    });
    return {
      gptBotAllowed: !isDisallowedInRobots(data, "GPTBot"),
      claudeBotAllowed: !isDisallowedInRobots(data, "ClaudeBot"),
    };
  } catch {
    return { gptBotAllowed: null, claudeBotAllowed: null };
  }
}
