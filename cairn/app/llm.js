/* Cairn — the model layer
 *
 * The browser never holds an API key. This talks to a small Cloudflare Worker
 * (see worker/) which holds the key and returns structured proposals. Until
 * that endpoint is configured the app falls back to the deterministic rules in
 * engine.js, which is why the feature works offline and costs nothing to run
 * at zero users.
 *
 * The digest below is the only thing that ever leaves the device, and the app
 * shows it to you in full before you send it. That disclosure is not decoration
 * — this record contains what someone wrote about the days they were not
 * coping, and a product that claims a privacy position has to be able to show
 * exactly what it transmits.
 */

import * as E from "./engine.js";

/** Set this to your deployed worker URL. Empty means "rules only". */
export const LLM_ENDPOINT = "";

const round = (n, places = 2) => Number(n.toFixed(places));

/**
 * Build the digest.
 *
 * Deliberately derived rather than raw: the model gets computed statistics —
 * streaks, consistency, weekday rates, the automaticity fit — rather than
 * every logged day, because the statistics are what the reasoning needs and
 * they are a fraction of the size. Notes are the exception; they carry the
 * *reason* a habit failed, which no statistic can, and they are the one part
 * a person can switch off.
 */
export function buildDigest(state, { includeNotes = true, asOf = new Date() } = {}) {
  const habits = state.habits.filter((h) => !h.archivedAt);

  return {
    today: E.dayKey(asOf),
    weekday: E.WEEKDAY_NAMES[E.weekday(asOf)],
    habits: habits.map((habit) => {
      const stats = E.statsFor(habit, asOf);
      const auto = E.automaticityFor(habit);
      const weekdayRates = {};
      stats.weekdayRates.forEach((rate, index) => {
        if (rate !== null) weekdayRates[E.WEEKDAY_SHORT[index]] = round(rate);
      });

      const entry = {
        name: habit.name,
        kind: habit.kind === E.KIND.QUIT ? "breaking" : "building",
        cue: habit.cue || null,
        tinyVersion: habit.tiny || null,
        celebration: habit.reward || null,
        identity: habit.identity || null,
        friction: habit.friction || null,
        schedule: E.scheduleSummary(habit),
        timesPerDay: habit.targetCount > 1 ? habit.targetCount : undefined,
        timerMinutes: habit.timerSeconds ? Math.round(habit.timerSeconds / 60) : undefined,
        ageInDays: E.daysBetween(habit.createdAt, asOf),
        stats: {
          currentStreak: stats.currentStreak,
          longestStreak: stats.longestStreak,
          totalRepetitions: stats.totalCompletions,
          consistency30: round(stats.consistency30),
          consistency7: round(stats.consistency7),
          momentumVsPreviousFortnight: Math.round(stats.momentum),
          completionRateByWeekday: weekdayRates,
          weakestWeekday: stats.weakestWeekday === null
            ? null : E.WEEKDAY_NAMES[stats.weakestWeekday],
        },
        automaticity: {
          // 1–7 on the Self-Report Behavioural Automaticity Index.
          current: round(auto.current, 1),
          measured: auto.measured !== null,
          fittedToThisPerson: auto.personalised,
          repetitionsRemainingToThreshold: auto.repsRemaining,
        },
      };

      if (includeNotes) {
        const notes = (habit.entries || [])
          .filter((e) => e.note || e.mood)
          .sort((a, b) => (a.day < b.day ? 1 : -1))
          .slice(0, 5)
          .map((e) => ({ day: e.day, note: e.note || undefined, mood: e.mood ?? undefined }));
        if (notes.length) entry.recentNotes = notes;
      }
      return entry;
    }),
    tasks: {
      dueToday: E.tasksForToday(state.tasks, asOf).length,
      late: state.tasks.filter((t) => !t.isDone && E.isLate(t, asOf)).length,
      openTotal: state.tasks.filter((t) => !t.isDone).length,
      titles: E.tasksForToday(state.tasks, asOf).slice(0, 6).map((t) => t.title),
    },
    recentReviews: (state.reflections || [])
      .slice()
      .sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1))
      .slice(0, 3)
      .map((r) => ({
        weekStart: E.dayKey(r.weekStart),
        whatIChanged: r.tweak || undefined,
        whereItBroke: r.obstacles || undefined,
      }))
      .filter((r) => r.whatIChanged || r.whereItBroke),
  };
}

export function isConfigured() {
  return Boolean(endpoint());
}

/** The endpoint, allowing an override saved in settings for testing. */
export function endpoint() {
  try {
    const saved = JSON.parse(localStorage.getItem("cairn.meta.v1") || "{}").llmEndpoint;
    if (saved) return saved;
  } catch {}
  return LLM_ENDPOINT;
}

/**
 * Ask for proposals.
 *
 * Returns `{ proposals, summary, source }`. On any failure — no endpoint, no
 * network, a rate limit, a refusal — it returns the deterministic proposals
 * instead, tagged `source: "rules"`. The feature never simply fails; it gets
 * quieter.
 */
export async function requestProposals(state, options = {}) {
  const fallback = () => ({
    proposals: E.proposals(state.habits.filter((h) => !h.archivedAt)).map((p) => ({
      habit: p.title.match(/“([^”]+)”/)?.[1] ?? "",
      lever: "cue",
      title: p.title,
      body: p.body,
      why: p.why,
      confidence: "medium",
    })),
    summary: "",
    source: "rules",
  });

  const url = endpoint();
  if (!url) return fallback();

  const digest = buildDigest(state, options);

  try {
    const controller = new AbortController();
    // A weekly review that hangs is worse than one that falls back.
    const timer = setTimeout(() => controller.abort(), 45000);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ digest }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      return { ...fallback(), error: detail.error || `The service returned ${response.status}.` };
    }
    const data = await response.json();
    if (!Array.isArray(data.proposals) || data.proposals.length === 0) {
      // An empty answer is a legitimate one — but show the rules rather than
      // an empty screen, and say which is which.
      return { ...fallback(), summary: data.summary || "", note: "Nothing new this week." };
    }
    return {
      proposals: data.proposals,
      summary: data.summary || "",
      source: "model",
      model: data.model,
      usage: data.usage,
    };
  } catch (error) {
    const reason = error.name === "AbortError"
      ? "That took too long, so here are the built-in rules instead."
      : "Couldn't reach the service, so here are the built-in rules instead.";
    return { ...fallback(), error: reason };
  }
}

export const LEVER_LABEL = {
  cue: "Change the cue",
  size: "Make it smaller",
  schedule: "Change the days",
  friction: "Move something",
  identity: "Reconnect it",
  drop: "Consider dropping it",
  hold: "Leave it alone",
};
