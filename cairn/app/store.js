/* Cairn — store
 *
 * Local-first persistence plus interoperability with the Mac app.
 *
 * Import and export use the Cairn v2 payload exactly as Sources/Shared/Store/
 * Transfer.swift writes it, so a file exported from the Mac app opens here and
 * a file exported here opens there. That is the whole reason the format is
 * plain JSON with human-readable keys: the point of an export is that you are
 * not dependent on any one of these apps.
 *
 * Internally the field names are short (cue, tiny, reward) because that is
 * what reads well in the engine; the mapping to the Swift DTO names happens at
 * the boundary, in one place, on purpose.
 */

import { dayKey, startOfDay, startOfWeek, SCHEDULE, KIND, PRIORITY } from "./engine.js";

const KEY = "cairn.store.v1";
const META = "cairn.meta.v1";

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export const TOKENS = ["cyan", "blue", "violet", "magenta", "green", "yellow", "orange", "red"];

export const EMOJI = ["🪨", "📖", "🏃", "💧", "🧠", "🎸", "✍️", "🧘", "🛏️", "🥗", "💻", "📵", "🧹", "☎️", "💸", "🌱"];

/** SF Symbol names the Mac app uses, mapped to something a browser can draw. */
const SYMBOL_TO_EMOJI = {
  "leaf.fill": "🌱", "book.fill": "📖", "figure.walk": "🏃", "figure.run": "🏃",
  "drop.fill": "💧", "brain.head.profile": "🧠", "music.note": "🎸",
  "pencil.and.scribble": "✍️", "figure.mind.and.body": "🧘", "bed.double.fill": "🛏️",
  "moon.stars.fill": "🛏️", "fork.knife": "🥗", "carrot.fill": "🥗",
  "terminal.fill": "💻", "keyboard": "💻", "desktopcomputer": "💻",
  "iphone.slash": "📵", "hand.raised.slash": "📵", "nosign": "📵",
  "sparkles": "🧹", "trash.fill": "🧹", "phone.fill": "☎️", "person.2.fill": "☎️",
  "banknote.fill": "💸", "heart.fill": "🌱", "dumbbell.fill": "🏃",
};

function emojiFor(symbol) {
  if (!symbol) return "🪨";
  if (!symbol.includes(".") && symbol.length <= 3) return symbol; // already an emoji
  return SYMBOL_TO_EMOJI[symbol] || "🪨";
}

// ---------------------------------------------------------------- shape

export function newHabit(partial = {}) {
  return {
    id: uid(),
    name: "",
    icon: "🪨",
    symbol: "",              // preserved for round-tripping to the Mac app
    colorToken: "cyan",
    kind: KIND.BUILD,
    category: "none",
    identity: "",
    cue: "",
    tiny: "",
    reward: "",
    friction: "",
    scheduleKind: SCHEDULE.DAILY,
    weekdayMask: 127,
    timesPerWeek: 3,
    targetCount: 1,
    unitLabel: "",
    timerSeconds: 0,
    repairsPerWeek: 1,
    sortIndex: 0,
    createdAt: new Date().toISOString(),
    archivedAt: null,
    entries: [],
    checks: [],
    ...partial,
  };
}

export function newTask(partial = {}) {
  return {
    id: uid(),
    title: "",
    notes: "",
    due: null,
    hasTime: false,
    isDone: false,
    completedAt: null,
    createdAt: new Date().toISOString(),
    priority: PRIORITY.NORMAL,
    colorToken: "blue",
    sortIndex: 0,
    ...partial,
  };
}

function emptyState() {
  return { habits: [], tasks: [], reflections: [] };
}

// ---------------------------------------------------------------- persistence

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    return {
      habits: parsed.habits || [],
      tasks: parsed.tasks || [],
      reflections: parsed.reflections || [],
    };
  } catch {
    // A corrupt store must not lock you out of the app. Start clean and keep
    // the broken copy so nothing is silently destroyed.
    try { localStorage.setItem(KEY + ".broken", localStorage.getItem(KEY) || ""); } catch {}
    return emptyState();
  }
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function meta() {
  try { return JSON.parse(localStorage.getItem(META) || "{}"); } catch { return {}; }
}

export function setMeta(patch) {
  const next = { ...meta(), ...patch };
  try { localStorage.setItem(META, JSON.stringify(next)); } catch {}
  return next;
}

// ---------------------------------------------------------------- mutations

export function logHabit(habit, total, when = new Date()) {
  const key = dayKey(when);
  const target = Math.max(1, habit.targetCount || 1);
  const clamped = Math.max(0, Math.min(total, target));
  habit.entries = (habit.entries || []).filter((e) => e.day !== key);
  if (clamped > 0) {
    habit.entries.push({
      day: key, count: clamped, note: "", mood: null,
      isRepair: false, durationSeconds: 0,
    });
  }
  return habit;
}

export function repairDay(habit, when) {
  const key = dayKey(when);
  if ((habit.entries || []).some((e) => e.day === key)) return habit;
  habit.entries.push({
    day: key, count: Math.max(1, habit.targetCount || 1), note: "Repaired",
    mood: null, isRepair: true, durationSeconds: 0,
  });
  return habit;
}

export function annotate(habit, when, { note, mood, durationSeconds } = {}) {
  const key = dayKey(when);
  let entry = (habit.entries || []).find((e) => e.day === key);
  if (!entry) {
    entry = { day: key, count: Math.max(1, habit.targetCount || 1), note: "", mood: null, isRepair: false, durationSeconds: 0 };
    habit.entries.push(entry);
  }
  if (note !== undefined) entry.note = note;
  if (mood !== undefined) entry.mood = mood;
  if (durationSeconds !== undefined) entry.durationSeconds = durationSeconds;
  return habit;
}

export function addCheck(habit, answers, when = new Date()) {
  const score = answers.reduce((a, b) => a + b, 0) / answers.length;
  habit.checks = habit.checks || [];
  habit.checks.push({
    date: new Date(when).toISOString(),
    a1: answers[0], a2: answers[1], a3: answers[2], a4: answers[3],
    score,
  });
  return habit;
}

// ---------------------------------------------------------------- transfer

const ISO = (d) => (d ? new Date(d).toISOString() : null);

export function toPayload(state) {
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    habits: (state.habits || []).map((h) => ({
      id: h.id,
      name: h.name,
      subtitle: "",
      symbol: h.symbol || "leaf.fill",
      colorToken: h.colorToken,
      kind: h.kind,
      category: h.category || "none",
      identityStatement: h.identity || "",
      cueText: h.cue || "",
      tinyVersion: h.tiny || "",
      rewardText: h.reward || "",
      frictionNotes: h.friction || "",
      scheduleKind: h.scheduleKind,
      weekdayMask: h.weekdayMask,
      timesPerWeek: h.timesPerWeek,
      targetCount: h.targetCount,
      unitLabel: h.unitLabel || "",
      timerSeconds: h.timerSeconds || 0,
      healthMetric: 0,
      healthTarget: 0,
      repairsPerWeek: h.repairsPerWeek ?? 1,
      sortIndex: h.sortIndex ?? 0,
      createdAt: ISO(h.createdAt),
      archivedAt: ISO(h.archivedAt),
      scheduleSummary: "",
      reminders: [],
      entries: (h.entries || []).map((e) => ({
        // The Swift side reads `day` as a full ISO timestamp at local midnight.
        day: new Date(e.day + "T00:00:00").toISOString(),
        count: e.count,
        note: e.note || "",
        mood: e.mood ?? null,
        isRepair: !!e.isRepair,
        durationSeconds: e.durationSeconds || 0,
        fromHealth: false,
      })),
      automaticity: (h.checks || []).map((c) => ({
        date: ISO(c.date), a1: c.a1, a2: c.a2, a3: c.a3, a4: c.a4,
      })),
      urges: [],
    })),
    tasks: (state.tasks || []).map((t) => ({
      id: t.id,
      title: t.title,
      notes: t.notes || "",
      due: ISO(t.due),
      hasTime: !!t.hasTime,
      isDone: !!t.isDone,
      completedAt: ISO(t.completedAt),
      createdAt: ISO(t.createdAt),
      priority: t.priority,
      colorToken: t.colorToken || "blue",
      sortIndex: t.sortIndex ?? 0,
    })),
    reflections: (state.reflections || []).map((r) => ({
      weekStart: ISO(r.weekStart),
      wins: r.wins || "",
      obstacles: r.obstacles || "",
      tweak: r.tweak || "",
      energy: r.energy ?? 3,
    })),
  };
}

/**
 * Merge a payload into the current state.
 *
 * Additive and idempotent, matching the Mac app's importer: a habit already
 * present is matched on id and not duplicated, days the store already has are
 * left alone, and nothing is ever deleted by an import. Running the same file
 * twice changes nothing the second time.
 */
export function mergePayload(state, payload) {
  const report = { habitsAdded: 0, habitsMerged: 0, entriesAdded: 0, tasksAdded: 0, reflectionsAdded: 0 };
  const version = payload.version || 1;
  const byId = new Map((state.habits || []).map((h) => [h.id, h]));
  const byName = new Map((state.habits || []).map((h) => [h.name.trim().toLowerCase(), h]));

  for (const dto of payload.habits || []) {
    let habit = byId.get(dto.id) || byName.get((dto.name || "").trim().toLowerCase());
    if (habit) {
      report.habitsMerged += 1;
    } else {
      habit = newHabit({
        id: dto.id || uid(),
        name: dto.name || "Untitled",
        symbol: dto.symbol || "",
        icon: emojiFor(dto.symbol),
        colorToken: dto.colorToken || "cyan",
        kind: dto.kind ?? KIND.BUILD,
        category: dto.category || "none",
        identity: dto.identityStatement || "",
        cue: dto.cueText || "",
        tiny: dto.tinyVersion || "",
        reward: dto.rewardText || "",
        friction: dto.frictionNotes || "",
        scheduleKind: dto.scheduleKind ?? SCHEDULE.DAILY,
        weekdayMask: dto.weekdayMask ?? 127,
        timesPerWeek: dto.timesPerWeek ?? 3,
        targetCount: dto.targetCount ?? 1,
        unitLabel: dto.unitLabel || "",
        timerSeconds: dto.timerSeconds || 0,
        repairsPerWeek: dto.repairsPerWeek ?? 1,
        sortIndex: dto.sortIndex ?? state.habits.length,
        createdAt: dto.createdAt || new Date().toISOString(),
        archivedAt: dto.archivedAt || null,
        entries: [],
        checks: [],
      });
      state.habits.push(habit);
      byId.set(habit.id, habit);
      report.habitsAdded += 1;
    }

    const seen = new Set((habit.entries || []).map((e) => e.day));
    for (const entry of dto.entries || []) {
      const key = dayKey(entry.day);
      if (seen.has(key)) continue;
      seen.add(key);
      habit.entries.push({
        day: key,
        count: entry.count ?? 1,
        note: entry.note || "",
        mood: entry.mood ?? null,
        isRepair: !!entry.isRepair,
        durationSeconds: entry.durationSeconds || 0,
      });
      report.entriesAdded += 1;
    }

    const checkDates = new Set((habit.checks || []).map((c) => c.date));
    for (const check of dto.automaticity || []) {
      const iso = ISO(check.date);
      if (checkDates.has(iso)) continue;
      const answers = [check.a1, check.a2, check.a3, check.a4];
      habit.checks.push({
        date: iso, a1: answers[0], a2: answers[1], a3: answers[2], a4: answers[3],
        score: check.score ?? answers.reduce((a, b) => a + b, 0) / 4,
      });
    }
  }

  const taskIds = new Set((state.tasks || []).map((t) => t.id));
  for (const dto of payload.tasks || []) {
    if (taskIds.has(dto.id)) continue;
    state.tasks.push(newTask({
      id: dto.id || uid(),
      title: dto.title || "Untitled",
      notes: dto.notes || "",
      due: dto.due || null,
      hasTime: !!dto.hasTime,
      isDone: !!dto.isDone,
      completedAt: dto.completedAt || null,
      createdAt: dto.createdAt || new Date().toISOString(),
      priority: dto.priority ?? PRIORITY.NORMAL,
      colorToken: dto.colorToken || "blue",
      sortIndex: dto.sortIndex ?? 0,
    }));
    report.tasksAdded += 1;
  }

  const weeks = new Set((state.reflections || []).map((r) => dayKey(r.weekStart)));
  for (const dto of payload.reflections || []) {
    const key = dayKey(dto.weekStart);
    if (weeks.has(key)) continue;
    weeks.add(key);
    state.reflections.push({
      weekStart: ISO(dto.weekStart),
      wins: dto.wins || "", obstacles: dto.obstacles || "",
      tweak: dto.tweak || "", energy: dto.energy ?? 3,
    });
    report.reflectionsAdded += 1;
  }

  return { report, version };
}

export function decodePayload(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "That file isn't valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.habits)) {
    return { error: "That file isn't a Cairn export, or it is damaged." };
  }
  // Version 1 wrote no version field, no ids, and the schedule as prose. What
  // it did carry is worth recovering, so it is read rather than refused.
  if (!parsed.version) {
    parsed.version = 1;
    parsed.habits = parsed.habits.map((h) => ({
      id: uid(),
      name: h.name,
      symbol: "leaf.fill",
      kind: (h.kind || "").toLowerCase() === "break" ? KIND.QUIT : KIND.BUILD,
      identityStatement: h.identity, cueText: h.cue, tinyVersion: h.tiny,
      rewardText: h.reward, frictionNotes: h.friction,
      createdAt: h.createdAt, archivedAt: h.archivedAt,
      entries: (h.entries || []).map((e) => ({
        day: e.day, count: e.count, note: e.note, isRepair: e.repaired,
      })),
      automaticity: [],
    }));
    parsed.tasks = [];
    parsed.reflections = [];
  }
  return { payload: parsed };
}

export function summariseReport(report, version) {
  const parts = [];
  if (report.habitsAdded) parts.push(`${report.habitsAdded} habit${report.habitsAdded === 1 ? "" : "s"} added`);
  if (report.habitsMerged) parts.push(`${report.habitsMerged} already here`);
  if (report.entriesAdded) parts.push(`${report.entriesAdded} logged day${report.entriesAdded === 1 ? "" : "s"}`);
  if (report.tasksAdded) parts.push(`${report.tasksAdded} task${report.tasksAdded === 1 ? "" : "s"}`);
  if (report.reflectionsAdded) parts.push(`${report.reflectionsAdded} review${report.reflectionsAdded === 1 ? "" : "s"}`);
  const body = parts.length ? parts.join(", ") + "." : "Nothing new in that file.";
  return version === 1 ? body + " (Read as an older version 1 export.)" : body;
}

// ---------------------------------------------------------------- example

/** A worked example, clearly labelled, so an empty app still shows what it does. */
export function exampleState() {
  const today = new Date();
  const iso = (d) => new Date(d).toISOString();
  const back = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d; };

  const reading = newHabit({
    name: "Read before bed", icon: "📖", symbol: "book.fill", colorToken: "violet",
    identity: "I am someone who reads every day.",
    cue: "After I get into bed, before I touch my phone.",
    tiny: "One page.", reward: "Note the page number.",
    createdAt: iso(back(40)), sortIndex: 0,
  });
  for (let i = 1; i < 40; i++) {
    if (i % 7 === 4) continue; // it dies on the same weekday — the app should notice
    reading.entries.push({ day: dayKey(back(i)), count: 1, note: "", mood: null, isRepair: false, durationSeconds: 0 });
  }
  reading.checks = [
    { date: iso(back(28)), a1: 2, a2: 2, a3: 3, a4: 2, score: 2.25 },
    { date: iso(back(14)), a1: 3, a2: 3, a3: 3, a4: 2, score: 2.75 },
    { date: iso(back(1)), a1: 3, a2: 3, a3: 3, a4: 3, score: 3.0 },
  ];

  const water = newHabit({
    name: "Water", icon: "💧", symbol: "drop.fill", colorToken: "cyan",
    cue: "With every meal.", tiny: "One glass.", targetCount: 8,
    createdAt: iso(back(30)), sortIndex: 1,
  });
  for (let i = 1; i < 30; i++) {
    water.entries.push({ day: dayKey(back(i)), count: 6 + (i % 3), note: "", mood: null, isRepair: false, durationSeconds: 0 });
  }

  const walk = newHabit({
    name: "Morning walk", icon: "🏃", symbol: "figure.walk", colorToken: "green",
    cue: "After I close the laptop.", tiny: "Shoes on, out the door.",
    timerSeconds: 1200, createdAt: iso(back(20)), sortIndex: 2,
  });
  for (let i = 1; i < 20; i += 2) {
    walk.entries.push({ day: dayKey(back(i)), count: 1, note: "", mood: null, isRepair: false, durationSeconds: 1200 });
  }

  const tasks = [
    newTask({ title: "Send the report draft", due: iso(back(2)), priority: PRIORITY.HIGH, sortIndex: 0 }),
    newTask({ title: "Book the dentist", due: iso(today), sortIndex: 1 }),
    newTask({ title: "Reply to the group email", due: iso(back(-1)), sortIndex: 2 }),
  ];

  return { habits: [reading, water, walk], tasks, reflections: [] };
}
