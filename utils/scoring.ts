import type {
  ClaudeFailureResponse,
  ClaudeResponse,
  ClaudeScore,
  ClaudeSuccessResponse,
  PriorityFix,
} from "./claude";
import type { Layer1Signals } from "./layer1";
import type { PageData, RobotsMeta } from "./types";
import { calcQ2, calcQ3, calcQ17, calcQ18 } from "./layer1Calculators";

interface FinalScore {
  score: number;
  tier: string;
  pillars: Record<string, number>;
  answers: Record<string, number>;
  scores: Record<string, ClaudeScore>;
  businessName: string;
  priorityFixes: PriorityFix[];
}

function resolveHomepage(pages: PageData[]): PageData | undefined {
  return (
    pages.find((page) => {
      try {
        return new URL(page.url).pathname === "/";
      } catch {
        return false;
      }
    }) ?? pages[0]
  );
}

const PILLARS: Record<string, string[]> = {
  foundation: ["q2", "q3"],
  intent: ["q1", "q13"],
  relevance: ["q4", "q5", "q6"],
  expertise: ["q7", "q8", "q9", "q16"],
  unify: ["q11", "q17"],
  performance: ["q14", "q15", "q18"],
};

const WEIGHTS: Record<string, number> = {
  foundation: 0.2,
  intent: 0.15,
  relevance: 0.2,
  expertise: 0.2,
  unify: 0.15,
  performance: 0.1,
};

function calcPillar(questions: string[], scores: Record<string, ClaudeScore>): number {
  const earned = questions.reduce((sum, question) => {
    return sum + (scores[question]?.score ?? 0);
  }, 0);

  return (earned / (questions.length * 2)) * 100;
}

function getTier(score: number): string {
  if (score <= 39) return "Hidden";
  if (score <= 69) return "Emerging";
  if (score <= 84) return "AI-Ready";
  return "AI-Optimized";
}

function isClaudeFailure(response: ClaudeResponse): response is ClaudeFailureResponse {
  return "error" in response;
}

function isClaudeSuccess(response: ClaudeResponse): response is ClaudeSuccessResponse {
  return !isClaudeFailure(response);
}

export function calculateScore(
  aiResponse: ClaudeResponse,
  pages: PageData[],
  robots: RobotsMeta,
  layer1?: Layer1Signals,
): FinalScore {
  if (!isClaudeSuccess(aiResponse)) {
    throw new Error(aiResponse.message);
  }

  const allScores: Record<string, ClaudeScore> = {
    ...aiResponse.scores,
    q2: calcQ2(pages, robots, layer1),
    q3: calcQ3(pages),
    q17: calcQ17(pages, layer1),
    q18: calcQ18(pages, layer1),
  };

  const pillarValues: Record<string, number> = {};
  for (const [pillar, questions] of Object.entries(PILLARS)) {
    pillarValues[pillar] = calcPillar(questions, allScores);
  }

  const total = Object.entries(WEIGHTS).reduce((sum, [pillar, weight]) => {
    return sum + (pillarValues[pillar] ?? 0) * weight;
  }, 0);

  const score = Math.round(total);
  const pillars = Object.fromEntries(
    Object.entries(pillarValues).map(([pillar, value]) => [pillar, Math.round(value)]),
  );

  const answers: Record<string, number> = {};
  for (const [question, result] of Object.entries(allScores)) {
    answers[question] = result.score;
  }
  return {
    score,
    tier: getTier(score),
    pillars,
    answers,
    scores: allScores,
    businessName: aiResponse.business_name || resolveHomepage(pages)?.businessName || "",
    priorityFixes: aiResponse.priority_fixes,
  };
}
