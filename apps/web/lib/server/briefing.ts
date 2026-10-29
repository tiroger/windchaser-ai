import "server-only";

import { createHash } from "node:crypto";

import { compassLabel, formatDelta, formatDuration } from "../geo";
import { formatHours } from "../training/activity-types";
import { readEnv } from "./env";
import { RateLimiter } from "./rate-limit";

import type {
  BriefingNearMiss,
  BriefingRanked,
  BriefingRoute,
} from "../briefing-evidence";

export type { BriefingEvaluation, BriefingSegment } from "../briefing-evidence";

/**
 * The narrative layer.
 *
 * ADR-0002 governs this file: the deterministic engine decides everything that
 * matters, and the model only explains evidence it was handed. It is never
 * allowed to invent a measurement, and the interface stays fully usable when
 * it is switched off or unavailable.
 *
 * COST_STRATEGY.md governs when it runs: one generation per material forecast
 * version, keyed by an evidence hash, never per page view.
 */

export type BriefingSource = "bedrock" | "anthropic" | "template";

export interface Briefing {
  headline: string;
  body: string;
  source: BriefingSource;
  evidence_hash: string;
  generated_at: string;
  model?: string;
}

export interface BriefingInput {
  regionName: string;
  athleteName: string | null;
  now: Date;
  timezone: string;
  ranked: BriefingRanked[];
  blockedCount: number;
  /** The week's closest misses on real records, best first. */
  nearMisses?: BriefingNearMiss[];
  /** The saved route the wind favours most on the relevant day. */
  route?: BriefingRoute | null;
}

/**
 * Model choice is configurable. Note that COST_STRATEGY.md recommends routing
 * simple summarisation to a smaller model once evaluations confirm quality.
 */
const MODEL = readEnv("WINDCHASER_BRIEFING_MODEL") ?? "claude-opus-5";
const BEDROCK_REGION = readEnv("AWS_REGION") ?? "us-west-2";

/** Operational kill switch required by the cost strategy. */
export function liveAiEnabled(): boolean {
  return (readEnv("LIVE_AI_ENABLED") ?? "true").toLowerCase() !== "false";
}

const cache = new Map<string, Briefing>();

/**
 * Hash the evidence, not the request. Two page views of the same forecast
 * version share one generation; a materially changed forecast makes a new key.
 */
export function evidenceHash(input: BriefingInput): string {
  const material = input.ranked.slice(0, 5).map((r) => [
    r.segment.id,
    r.whenIso,
    Math.round(r.evaluation.score * 50),
    Math.round(r.evaluation.predicted_time_s),
    Math.round(r.evaluation.weather.wind_speed_ms * 2),
    Math.round(r.evaluation.weather.wind_from_deg / 15),
  ]);
  const still = input.ranked.slice(0, 5).map((r) => {
    const sa = r.segment.still_air;
    return sa ? [sa.best_s, sa.pr_rank, sa.rough] : null;
  });
  const misses = (input.nearMisses ?? []).map((m) => [m.name, m.when, Math.round(m.gap_s)]);
  const route = input.route
    ? [input.route.name, input.route.start_label, input.route.predicted_s, input.route.saved_s]
    : null;
  return createHash("sha256")
    .update(JSON.stringify({ region: input.regionName, material, still, misses, route }))
    .digest("hex")
    .slice(0, 16);
}

/**
 * "Sunday 1 PM" from a forecast wall-clock hour. Read as written, never
 * through the server's own time zone, which knows nothing of the rider's.
 */
export function wallClockLabel(time: string): string {
  const instant = Date.parse(`${time.slice(0, 16)}:00Z`);
  if (!Number.isFinite(instant)) return time;
  const day = new Date(instant).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const hour = new Date(instant).toLocaleTimeString("en-US", { hour: "numeric", timeZone: "UTC" });
  return `${day} ${hour}`;
}

const ORDINAL = new Intl.PluralRules("en-US", { type: "ordinal" });
const SUFFIX: Record<string, string> = { one: "st", two: "nd", few: "rd", other: "th" };
const ordinal = (n: number) => `${n}${SUFFIX[ORDINAL.select(n)] ?? "th"}`;

const DAY_WORDS = { today: "today", tomorrow: "tomorrow", weekend: "this weekend" } as const;

function describe(r: BriefingInput["ranked"][number]): string {
  const { segment, evaluation, whenIso } = r;
  const [day, hour] = wallClockLabel(whenIso).split(/ (.*)/);
  const delta = segment.target_time_s
    ? formatDelta(evaluation.predicted_time_s - segment.target_time_s)
    : "no recorded time to compare against";
  const tail = evaluation.effective_tailwind_ms;
  const assist =
    tail > 0.4 ? `${tail.toFixed(1)} m/s net tailwind`
      : tail < -0.4 ? `${Math.abs(tail).toFixed(1)} m/s net headwind`
      : "no net wind assistance";

  return [
    `- ${segment.name} (${(segment.distance_m / 1000).toFixed(1)} km, ` +
      `${segment.average_grade.toFixed(1)}% average grade)`,
    `  best window: ${day} ${hour}`,
    `  predicted ${formatDuration(evaluation.predicted_time_s)} vs best ` +
      `${segment.target_time_s ? formatDuration(segment.target_time_s) : "none"} (${delta})`,
    `  chance of beating PR: ${
      evaluation.p_beat === null ? "not applicable" : `${Math.round(evaluation.p_beat * 100)}%`
    }`,
    `  wind ${evaluation.weather.wind_speed_ms.toFixed(1)} m/s from ` +
      `${compassLabel(evaluation.weather.wind_from_deg)}, gusting ` +
      `${evaluation.weather.gust_ms.toFixed(1)}; ${assist}`,
    `  crosswind ${evaluation.mean_crosswind_ms.toFixed(1)} m/s, ` +
      `${evaluation.weather.temperature_c.toFixed(0)}°C, ` +
      `${evaluation.weather.precip_prob.toFixed(0)}% chance of rain`,
    ...stillAirLine(segment),
  ].join("\n");
}

/** The rider's best with the wind taken out, when the history has one. */
function stillAirLine(segment: BriefingRanked["segment"]): string[] {
  const sa = segment.still_air;
  if (!sa) return [];
  const rank =
    sa.pr_rank !== null ? `; the PR ranks ${ordinal(sa.pr_rank)} of ${sa.count} in still air` : "";
  const rough = sa.rough
    ? "; rough here: still-air times track the power meter poorly on this segment, so treat them loosely"
    : "";
  return [`  still air: best ${formatDuration(sa.best_s)} against a recorded PR of ${formatDuration(sa.pr_s)}${rank}${rough}`];
}

function describeMiss(m: BriefingNearMiss): string {
  return (
    `- ${m.name}: best rideable hour ${wallClockLabel(m.when)}, predicted ${formatDuration(m.predicted_s)} ` +
    `vs record ${formatDuration(m.target_s)} (${formatDelta(m.gap_s)}), ${Math.round(m.p_beat * 100)}% chance`
  );
}

function describeRoute(route: BriefingRoute): string {
  const saved = Math.round(route.saved_s / 60);
  const effect =
    saved > 0 ? `${saved} min faster than calm air` : saved < 0 ? `${-saved} min slower than calm air` : "no faster than calm air";
  return [
    `- ${route.name}, ${route.distance_mi} mi, best start ${route.start_label}`,
    `  predicted ${formatHours(route.predicted_s / 3600)} moving against ${formatHours(route.calm_s / 3600)} in calm air (${effect})`,
    `  tailwind on ${route.tail_pct}% of the route; ${route.before_sunset ? "back before sunset" : "finishes after sunset"}`,
  ].join("\n");
}

export function buildPrompt(input: BriefingInput): string {
  const lines = input.ranked.map(describe).join("\n");
  return [
    `Region: ${input.regionName}`,
    `Local time now: ${input.now.toLocaleString("en-US", { timeZone: input.timezone })}`,
    input.blockedCount > 0
      ? `${input.blockedCount} other windows were rejected outright by safety gates.`
      : "No windows were rejected by safety gates.",
    "",
    "Ranked opportunities over the next seven days:",
    lines,
    ...(input.nearMisses?.length
      ? ["", "Near misses this week (best rideable hour, not within reach of the record):", ...input.nearMisses.map(describeMiss)]
      : []),
    ...(input.route
      ? ["", `Best saved route for the wind ${DAY_WORDS[input.route.day]}:`, describeRoute(input.route)]
      : []),
  ].join("\n");
}

const SYSTEM = `You write a short pre-ride briefing for a cyclist deciding when to attack a segment for a personal best.

You are given the complete output of a deterministic wind and time model. Your job is to turn those numbers into judgement a rider can act on.

Rules you must follow:
- Never state a number that is not in the evidence. Do not estimate, round differently, or infer values that were not given.
- Do not claim a ride is safe. The gates already handled safety; you may mention that a window was rejected, but never reassure.
- Lead with the single best opportunity and say plainly why the wind favours it.
- If nothing is genuinely good, say so directly rather than manufacturing enthusiasm.
- Mention a tradeoff when one exists, for example a strong tailwind arriving with gusts or rain.
- You may add, briefly and only when it helps: the rider's still-air best on a segment (their best with the wind taken out, and where their PR ranks there), honouring any "rough here" caveat; a near miss worth knowing about; and the best saved route for a longer ride. Use only the figures given for them.
- Write in second person, plain language, no exclamation marks, no cycling cliches, no emoji.

Respond as JSON matching this shape exactly:
{"headline": "<max 60 characters, specific to the best window>", "body": "<2 to 5 sentences>"}`;

/** Always-available fallback. Same evidence, no model. */
export function templateBriefing(input: BriefingInput): Briefing {
  // One sentence per fact, each restating a figure from the evidence.
  const hash = evidenceHash(input);
  const best = input.ranked[0];

  if (!best) {
    const route = routeSentence(input.route);
    return {
      headline: "No rideable windows in the next seven days",
      body: [
        input.blockedCount > 0
          ? `Every window in this region was rejected by a safety gate, ${input.blockedCount} in total. Check back once the forecast updates.`
          : "There are no scored windows for this region yet.",
        route,
      ]
        .filter(Boolean)
        .join(" "),
      source: "template",
      evidence_hash: hash,
      generated_at: new Date().toISOString(),
    };
  }

  const [day, hour] = wallClockLabel(best.whenIso).split(/ (.*)/);
  const tail = best.evaluation.effective_tailwind_ms;
  const pr = best.segment.target_time_s;
  const chance =
    best.evaluation.p_beat === null
      ? null
      : Math.round(best.evaluation.p_beat * 100);

  const windPhrase =
    tail > 0.4
      ? `a ${tail.toFixed(1)} m/s net tailwind along the segment`
      : tail < -0.4
        ? `a ${Math.abs(tail).toFixed(1)} m/s net headwind`
        : "no meaningful net wind assistance";

  const sentences = [
    `${day} at ${hour} is the strongest window on ${best.segment.name}, with ${windPhrase}.`,
    pr
      ? `The model predicts ${formatDuration(best.evaluation.predicted_time_s)} against your PR of ${formatDuration(pr)}${
          chance !== null ? `, a ${chance}% chance of beating it` : ""
        }.`
      : `The model predicts ${formatDuration(best.evaluation.predicted_time_s)}; there is no PR on record to compare against.`,
  ];

  if (best.evaluation.weather.precip_prob > 40) {
    sentences.push(
      `Rain probability is ${best.evaluation.weather.precip_prob.toFixed(0)}%, so the surface may be wet.`,
    );
  }
  if (best.evaluation.weather.gust_ms - best.evaluation.weather.wind_speed_ms > 5) {
    sentences.push(
      `Gusts reach ${best.evaluation.weather.gust_ms.toFixed(1)} m/s, which will make handling less predictable than the average suggests.`,
    );
  }
  if (input.blockedCount > 0) {
    sentences.push(`${input.blockedCount} other windows were rejected by safety gates.`);
  }
  const route = routeSentence(input.route);
  if (route) sentences.push(route);

  return {
    headline: `${day} ${hour} on ${best.segment.name}`.slice(0, 60),
    body: sentences.join(" "),
    source: "template",
    evidence_hash: hash,
    generated_at: new Date().toISOString(),
  };
}

/** The template's word on the best saved route, or null without one. */
function routeSentence(route: BriefingRoute | null | undefined): string | null {
  if (!route) return null;
  const saved = Math.round(route.saved_s / 60);
  const effect =
    saved > 0 ? `, ${saved} min faster than in calm air` : saved < 0 ? `, ${-saved} min slower than in calm air` : "";
  return (
    `For a longer ride, ${route.name} (${route.distance_mi} mi) is the best saved route for the wind ` +
    `${DAY_WORDS[route.day]}: ${formatHours(route.predicted_s / 3600)} moving from a ${route.start_label} start${effect}.`
  );
}

async function callBedrock(prompt: string): Promise<{ headline: string; body: string }> {
  const { AnthropicBedrockMantle } = await import("@anthropic-ai/bedrock-sdk");
  const client = new AnthropicBedrockMantle({ awsRegion: BEDROCK_REGION });
  const response = await client.messages.create({
    model: `anthropic.${MODEL}`,
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  return parseReply(response.content);
}

async function callAnthropic(prompt: string): Promise<{ headline: string; body: string }> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  return parseReply(response.content);
}

function parseReply(content: Array<{ type: string; text?: string }>) {
  const text = content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Model returned no JSON object");
  const parsed = JSON.parse(match[0]) as { headline?: string; body?: string };
  if (!parsed.headline || !parsed.body) throw new Error("Model JSON missing fields");
  return { headline: parsed.headline, body: parsed.body };
}

/**
 * Model calls per compute instance per hour. The route is public and the
 * evidence comes from the browser, so without a ceiling anyone could spend the
 * model budget by varying it. Over the limit the template answers instead, and
 * is not cached, so the next window can still produce the model's version.
 */
const modelCalls = new RateLimiter(60, 60 * 60 * 1000);
/** Evidence sets held; the oldest goes first once full. */
const CACHE_LIMIT = 500;

function remember(hash: string, briefing: Briefing): Briefing {
  cache.set(hash, briefing);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return briefing;
}

export async function generateBriefing(input: BriefingInput): Promise<Briefing> {
  const hash = evidenceHash(input);
  const hit = cache.get(hash);
  if (hit) return hit;

  if (!liveAiEnabled()) return remember(hash, templateBriefing(input));
  if (!modelCalls.take("model").ok) return templateBriefing(input);

  const prompt = buildPrompt(input);
  const haveAws = Boolean(
    readEnv("AWS_ACCESS_KEY_ID") ||
      readEnv("AWS_PROFILE") ||
      readEnv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") ||
      readEnv("AWS_WEB_IDENTITY_TOKEN_FILE"),
  );
  const haveAnthropic = Boolean(readEnv("ANTHROPIC_API_KEY"));

  const attempts: Array<[BriefingSource, () => Promise<{ headline: string; body: string }>]> = [];
  if (haveAws) attempts.push(["bedrock", () => callBedrock(prompt)]);
  if (haveAnthropic) attempts.push(["anthropic", () => callAnthropic(prompt)]);

  for (const [source, run] of attempts) {
    try {
      const { headline, body } = await run();
      const briefing: Briefing = {
        headline,
        body,
        source,
        evidence_hash: hash,
        generated_at: new Date().toISOString(),
        model: MODEL,
      };
      return remember(hash, briefing);
    } catch (error) {
      console.warn(
        `[briefing] ${source} failed, falling through:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return remember(hash, templateBriefing(input));
}
