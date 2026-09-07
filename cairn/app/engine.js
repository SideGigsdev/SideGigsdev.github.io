/* Cairn — engine
 *
 * A faithful port of the Swift engine in Sources/Shared/Engine. Same rules,
 * same deliberate positions: an unfinished today never breaks a streak,
 * unscheduled days are transparent, one repair a week covers a miss, and
 * automaticity is modelled against repetitions rather than calendar days.
 *
 * Pure functions only — no DOM, no storage. Everything here is testable and is
 * exercised by tests.js.
 */

// ---------------------------------------------------------------- dates

export const DAY = 86400000;

export function dayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(date, n) {
  const d = startOfDay(date);
  d.setDate(d.getDate() + n);
  return d;
}

/** Whole days from a to b, ignoring clock time and DST wobble. */
export function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / DAY);
}

export function weekday(date) {
  return new Date(date).getDay(); // 0 = Sunday, matching the Swift weekdayMask
}

export function startOfWeek(date) {
  return addDays(date, -weekday(date));
}

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---------------------------------------------------------------- schedule

export const SCHEDULE = { DAILY: 0, WEEKDAYS: 1, TIMES_PER_WEEK: 2 };
export const KIND = { BUILD: 0, QUIT: 1 };

export function isScheduled(habit, date) {
  switch (habit.scheduleKind) {
    case SCHEDULE.WEEKDAYS:
      return (habit.weekdayMask & (1 << weekday(date))) !== 0;
    case SCHEDULE.TIMES_PER_WEEK:
      // A flexible quota has no per-day obligation, so every day is a
      // legitimate opportunity.
      return true;
    default:
      return true;
  }
}

export function scheduleSummary(habit) {
  if (habit.scheduleKind === SCHEDULE.TIMES_PER_WEEK) {
    return `${habit.timesPerWeek}× a week`;
  }
  if (habit.scheduleKind === SCHEDULE.DAILY || habit.weekdayMask === 127) return "Every day";
  const picked = [];
  for (let i = 0; i < 7; i++) if (habit.weekdayMask & (1 << i)) picked.push(WEEKDAY_SHORT[i]);
  if (picked.length === 0) return "No days set";
  const key = picked.join(",");
  if (key === "Mon,Tue,Wed,Thu,Fri") return "Weekdays";
  if (key === "Sun,Sat") return "Weekends";
  return picked.join(" · ");
}

// ---------------------------------------------------------------- day status

export const STATE = {
  DONE: "done",
  PARTIAL: "partial",
  REPAIRED: "repaired",
  MISSED: "missed",
  OFF: "offDay",
  PRE: "preHistory",
};

function entriesByDay(habit) {
  const map = new Map();
  for (const entry of habit.entries || []) {
    const key = entry.day;
    const prior = map.get(key) || { count: 0, repair: false };
    map.set(key, {
      count: prior.count + Math.max(0, entry.count || 0),
      repair: prior.repair || !!entry.isRepair,
    });
  }
  return map;
}

/** Per-day picture over a window ending on `asOf`. */
export function daysFor(habit, window, asOf = new Date()) {
  const end = startOfDay(asOf);
  const birth = startOfDay(habit.createdAt);
  const target = Math.max(1, habit.targetCount || 1);
  const logged = entriesByDay(habit);
  const out = [];

  for (let i = window - 1; i >= 0; i--) {
    const day = addDays(end, -i);
    const key = dayKey(day);
    const hit = logged.get(key);
    const count = hit ? hit.count : 0;
    let state;
    if (day < birth) {
      state = count >= target ? STATE.DONE : STATE.PRE;
    } else if (hit && hit.repair && count < target) {
      state = STATE.REPAIRED;
    } else if (count >= target) {
      state = STATE.DONE;
    } else if (count > 0) {
      state = STATE.PARTIAL;
    } else if (isScheduled(habit, day)) {
      state = STATE.MISSED;
    } else {
      state = STATE.OFF;
    }
    out.push({ day, key, state, count, target, counts: state === STATE.DONE || state === STATE.REPAIRED });
  }
  return out;
}

/**
 * Current streak.
 *
 * Two deliberate choices carried over from the Mac app. Unscheduled days are
 * transparent — a Tue/Thu habit has not failed on Wednesday. And an unfinished
 * *today* is not a miss until the day is over, because a streak shown as broken
 * at 9am is a lie that costs people the day.
 */
export function currentStreak(days) {
  if (!days.length) return 0;
  let streak = 0;
  let i = days.length - 1;
  if (!days[i].counts) i -= 1; // today is still open
  for (; i >= 0; i--) {
    const day = days[i];
    if (day.counts) streak += 1;
    else if (day.state === STATE.OFF) continue;
    else return streak;
  }
  return streak;
}

export function longestStreak(days) {
  let best = 0, run = 0;
  for (const day of days) {
    if (day.counts) { run += 1; best = Math.max(best, run); }
    else if (day.state === STATE.OFF) continue;
    else run = 0;
  }
  return Math.max(best, run);
}

export function weekStreak(habit, days, asOf = new Date()) {
  const quota = Math.max(1, habit.timesPerWeek || 1);
  const buckets = new Map();
  for (const day of days) {
    if (!day.counts) continue;
    const key = dayKey(startOfWeek(day.day));
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  let cursor = startOfWeek(asOf);
  let streak = 0;
  if ((buckets.get(dayKey(cursor)) || 0) >= quota) streak += 1;
  cursor = addDays(cursor, -7);
  while ((buckets.get(dayKey(cursor)) || 0) >= quota) {
    streak += 1;
    cursor = addDays(cursor, -7);
  }
  return streak;
}

export function consistency(days, window, habit) {
  const slice = days.slice(-window);
  if (!slice.length) return 0;
  if (habit.scheduleKind === SCHEDULE.TIMES_PER_WEEK) {
    const weeks = Math.max(1, slice.length / 7);
    const demand = weeks * Math.max(1, habit.timesPerWeek || 1);
    return Math.min(1, slice.filter((d) => d.counts).length / demand);
  }
  const chances = slice.filter((d) => d.state !== STATE.OFF && d.state !== STATE.PRE);
  if (!chances.length) return 0;
  return chances.filter((d) => d.counts).length / chances.length;
}

export function statsFor(habit, asOf = new Date()) {
  const window = Math.max(120, daysBetween(habit.createdAt, asOf) + 7);
  const days = daysFor(habit, window, asOf);
  const quota = habit.scheduleKind === SCHEDULE.TIMES_PER_WEEK;

  const hits = new Array(7).fill(0);
  const chances = new Array(7).fill(0);
  for (const day of days) {
    if (day.state === STATE.PRE || day.state === STATE.OFF) continue;
    const w = weekday(day.day);
    chances[w] += 1;
    if (day.counts) hits[w] += 1;
  }
  const weekdayRates = hits.map((h, i) => (chances[i] === 0 ? null : h / chances[i]));

  const recent = consistency(days, 14, habit);
  const earlier = consistency(days.slice(0, -14), 14, habit);
  const last = days[days.length - 1];

  let weakest = null;
  const rated = weekdayRates.map((r, i) => [i, r]).filter(([, r]) => r !== null);
  if (rated.length >= 3) {
    const worst = rated.reduce((a, b) => (b[1] < a[1] ? b : a));
    if (worst[1] < 0.6) weakest = worst[0];
  }

  return {
    days,
    currentStreak: quota ? weekStreak(habit, days, asOf) : currentStreak(days),
    longestStreak: longestStreak(days),
    streakUnit: quota ? "week" : "day",
    totalCompletions: days.filter((d) => d.state === STATE.DONE).length,
    consistency30: consistency(days, 30, habit),
    consistency7: consistency(days, 7, habit),
    momentum: (recent - earlier) * 100,
    weekdayRates,
    weakestWeekday: weakest,
    isDoneToday: last ? last.counts : false,
    todayCount: last ? last.count : 0,
    repairsUsedThisWeek: (habit.entries || []).filter(
      (e) => e.isRepair && new Date(e.day) >= startOfWeek(asOf)
    ).length,
  };
}

// ---------------------------------------------------------------- automaticity

/**
 * A(n) = A0 + (Amax - A0)(1 - e^(-n/r)) over repetitions, not calendar days.
 * Seeded from Lally's published median: ~95% of the plateau at 66 repetitions
 * gives r ≈ 22, refitted to the person once three check-ins exist.
 */
export const AUTO = { FLOOR: 1, CEILING: 7, THRESHOLD: 5.5, PRIOR_RATE: 22 };

export function autoValue(reps, rate) {
  if (rate <= 0) return AUTO.FLOOR;
  return AUTO.FLOOR + (AUTO.CEILING - AUTO.FLOOR) * (1 - Math.exp(-reps / rate));
}

export function autoReps(value, rate) {
  const clamped = Math.min(AUTO.CEILING - 0.001, Math.max(AUTO.FLOOR, value));
  const ratio = (clamped - AUTO.FLOOR) / (AUTO.CEILING - AUTO.FLOOR);
  return -rate * Math.log(1 - ratio);
}

export function automaticityFor(habit) {
  const entries = (habit.entries || []).filter((e) => !e.isRepair);
  const total = entries.length;
  const checks = (habit.checks || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  const latest = checks.length ? checks[checks.length - 1].score : null;

  const samples = checks
    .map((c) => {
      const reps = entries.filter((e) => new Date(e.day) <= new Date(c.date)).length;
      return [reps, c.score];
    })
    .filter(([n, score]) => {
      const ratio = (score - AUTO.FLOOR) / (AUTO.CEILING - AUTO.FLOOR);
      return n > 0 && ratio > 0.001 && ratio < 0.98;
    })
    .map(([n, score]) => [n, -Math.log(1 - (score - AUTO.FLOOR) / (AUTO.CEILING - AUTO.FLOOR))]);

  let rate = AUTO.PRIOR_RATE;
  let personalised = false;
  if (samples.length >= 3) {
    const num = samples.reduce((s, [n, y]) => s + n * y, 0);
    const den = samples.reduce((s, [n]) => s + n * n, 0);
    if (den > 0 && num > 0) {
      // Clamped to the 18–254 day range the study actually observed.
      rate = Math.min(85, Math.max(6, den / num));
      personalised = true;
    }
  }

  const predicted = autoValue(total, rate);
  const current = latest === null ? predicted : latest;
  const progress = Math.max(0, Math.min(1, (current - AUTO.FLOOR) / (AUTO.THRESHOLD - AUTO.FLOOR)));

  let repsRemaining = null;
  if (current < AUTO.THRESHOLD) {
    const needed = autoReps(AUTO.THRESHOLD, rate);
    const effective = latest === null ? total : autoReps(latest, rate);
    repsRemaining = Math.max(1, Math.ceil(needed - effective));
  }

  return { rate, personalised, measured: latest, repetitions: total, current, progress, repsRemaining };
}

export function automaticityVerdict(value) {
  if (value < 2.5) return "Still fully manual. Every rep is a decision you have to win.";
  if (value < 4.0) return "Starting to catch. The cue is working some of the time.";
  if (value < 5.5) return "Most of the way. It pulls you now more than you push it.";
  return "Running on its own. You can stop spending willpower here.";
}

export const SRBAI_PROMPTS = [
  "I do it automatically.",
  "I do it without having to consciously remember.",
  "I do it without thinking about it.",
  "I start doing it before I realise I'm doing it.",
];

// ---------------------------------------------------------------- milestones

export const MILESTONES = [1, 3, 7, 14, 21, 30, 45, 66, 100, 150, 200, 250, 365];

export function nextMilestone(streak) {
  return MILESTONES.find((m) => m > streak) ?? null;
}

export function milestoneNote(value) {
  const notes = {
    1: "The first rep. Nothing is harder to start than a chain with no links.",
    3: "Three in a row. The cue is beginning to mean something.",
    7: "A full week. You now have evidence, not just intent.",
    14: "Two weeks. Early automaticity gains are steepest right here.",
    21: "Twenty-one days — the number the magazines print. The research says you're roughly a third of the way.",
    30: "A month. Long enough that the behaviour has survived a bad week.",
    45: "Forty-five. Past the point where most abandoned attempts die.",
    66: "Sixty-six — the median time to automaticity in Lally's study. If it still feels effortful, you're in the normal half of the range.",
    100: "One hundred repetitions. For most behaviours this is well past the plateau.",
    365: "A year. This is simply who you are now.",
  };
  return notes[value] || `${value} in a row.`;
}

/** The goal gradient only pulls when the target is close. */
export function approaching(streak, within = 3) {
  if (streak <= 0) return null;
  const next = nextMilestone(streak);
  if (next === null) return null;
  const remaining = next - streak;
  return remaining <= within ? { remaining, milestone: next } : null;
}

// ---------------------------------------------------------------- tasks

export const PRIORITY = { LOW: 0, NORMAL: 1, HIGH: 2 };
export const BUCKET = {
  OVERDUE: "overdue", TODAY: "today", TOMORROW: "tomorrow",
  THIS_WEEK: "thisWeek", LATER: "later", SOMEDAY: "someday",
};
export const BUCKET_TITLE = {
  overdue: "Late", today: "Today", tomorrow: "Tomorrow",
  thisWeek: "This week", later: "Later", someday: "No date",
};

export function bucketFor(task, asOf = new Date()) {
  if (!task.due) return BUCKET.SOMEDAY;
  const today = startOfDay(asOf);
  const dueDay = startOfDay(task.due);
  if (dueDay < today) return BUCKET.OVERDUE;
  if (dueDay.getTime() === today.getTime()) {
    return task.hasTime && new Date(task.due) < asOf ? BUCKET.OVERDUE : BUCKET.TODAY;
  }
  const gap = daysBetween(today, dueDay);
  if (gap === 1) return BUCKET.TOMORROW;
  if (gap <= 7) return BUCKET.THIS_WEEK;
  return BUCKET.LATER;
}

export function orderTasks(tasks) {
  return tasks.slice().sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.due && b.due && a.due !== b.due) return new Date(a.due) - new Date(b.due);
    if (a.due && !b.due) return -1;
    if (!a.due && b.due) return 1;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });
}

export function tasksForToday(tasks, asOf = new Date()) {
  const live = tasks.filter((t) => !t.isDone);
  const late = orderTasks(live.filter((t) => bucketFor(t, asOf) === BUCKET.OVERDUE));
  const due = orderTasks(live.filter((t) => bucketFor(t, asOf) === BUCKET.TODAY));
  return late.concat(due);
}

export function groupTasks(tasks, asOf = new Date()) {
  const order = [BUCKET.OVERDUE, BUCKET.TODAY, BUCKET.TOMORROW, BUCKET.THIS_WEEK, BUCKET.LATER, BUCKET.SOMEDAY];
  const buckets = new Map();
  for (const task of tasks.filter((t) => !t.isDone)) {
    const b = bucketFor(task, asOf);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(task);
  }
  return order
    .filter((b) => buckets.has(b))
    .map((b) => ({ bucket: b, title: BUCKET_TITLE[b], tasks: orderTasks(buckets.get(b)) }));
}

/**
 * Concrete rather than relative-and-vague. People systematically underestimate
 * how long things take, and "soon" does nothing to correct that where
 * "Thursday, 2 days" does.
 */
export function countdownFor(task, asOf = new Date()) {
  if (!task.due) return "No date";
  const days = daysBetween(startOfDay(asOf), startOfDay(task.due));
  if (task.hasTime && days === 0) {
    const minutes = Math.round((new Date(task.due) - asOf) / 60000);
    if (minutes < -60) return `${Math.floor(-minutes / 60)}h late`;
    if (minutes < 0) return `${-minutes}m late`;
    if (minutes < 60) return `in ${Math.max(1, minutes)}m`;
    return `in ${Math.floor(minutes / 60)}h`;
  }
  if (days < -1) return `${-days} days late`;
  if (days === -1) return "1 day late";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days <= 6) return WEEKDAY_NAMES[weekday(task.due)];
  return new Date(task.due).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function isLate(task, asOf = new Date()) {
  return bucketFor(task, asOf) === BUCKET.OVERDUE;
}

// ---------------------------------------------------------------- the brief

/**
 * The redesign proposals.
 *
 * These are the rules from the Mac app's weekly review, made explicit. They
 * are deterministic and cite their reasoning — which is the shape the language
 * model will later fill in, not replace. A proposal always names a change to
 * the *design* of a habit (its cue, size, schedule or friction), never a
 * motivational line.
 */
export function proposals(habits, asOf = new Date()) {
  const out = [];
  for (const habit of habits) {
    if (habit.archivedAt) continue;
    const stats = statsFor(habit, asOf);
    const auto = automaticityFor(habit);

    if (stats.weakestWeekday !== null) {
      const name = WEEKDAY_NAMES[stats.weakestWeekday];
      out.push({
        habit: habit.id,
        severity: 2,
        title: `“${habit.name}” keeps dying on ${name}s`,
        body: `That is a scheduling problem, not a willpower one. Move the cue on ${name}s, or drop to the small version — ${habit.tiny || "the smallest useful amount"} — on that day only.`,
        why: "A habit failing on the same weekday has one shared cause, not seven separate failures of will.",
      });
    }

    if (stats.momentum <= -20) {
      out.push({
        habit: habit.id,
        severity: 2,
        title: `“${habit.name}” is down ${Math.round(-stats.momentum)} points on the fortnight before`,
        body: `Shrink it to ${habit.tiny || "the smallest version"} for a week rather than trying to recover the full size. Repetitions build automaticity; duration does not.`,
        why: "Lally et al. (2010) — growth tracks the number of repetitions, not how long each one takes.",
      });
    }

    if (stats.currentStreak >= 21 && auto.measured !== null && auto.current < 3.5) {
      out.push({
        habit: habit.id,
        severity: 3,
        title: `“${habit.name}” has a long run but still feels manual`,
        body: "A streak held on discipline means the cue is moving around. Pin it to one fixed thing you already do every day — an existing routine, not a clock time.",
        why: "Habits are stored as context–response associations. An unstable context cannot form one.",
      });
    }

    if (!habit.cue && stats.totalCompletions >= 3) {
      out.push({
        habit: habit.id,
        severity: 1,
        title: `“${habit.name}” has no cue written down`,
        body: "Name the time and place, or the action it follows. This is the single highest-return field on the form.",
        why: "Gollwitzer & Sheeran (2006): implementation intentions, d ≈ 0.65 across 94 studies.",
      });
    }
  }
  return out.sort((a, b) => b.severity - a.severity);
}

/** The one thing to say at the top of the morning brief. */
export function briefLead(habits, tasks, asOf = new Date()) {
  const due = habits.filter((h) => !h.archivedAt && h.kind === KIND.BUILD && isScheduled(h, asOf));
  const done = due.filter((h) => statsFor(h, asOf).isDoneToday).length;
  const open = due.length - done;
  const todayTasks = tasksForToday(tasks, asOf);
  const late = todayTasks.filter((t) => isLate(t, asOf)).length;

  const parts = [];
  if (due.length === 0 && todayTasks.length === 0) return "Nothing scheduled today. That is allowed to be the whole plan.";
  if (open > 0) parts.push(`${open} habit${open === 1 ? "" : "s"} still open`);
  else if (due.length) parts.push("every habit already done");
  if (todayTasks.length) {
    parts.push(`${todayTasks.length} task${todayTasks.length === 1 ? "" : "s"}`);
  }
  let line = parts.join(", ") + ".";
  line = line.charAt(0).toUpperCase() + line.slice(1);
  if (late > 0) line += ` ${late} carried over from earlier.`;
  return line;
}

export const PROMPTS = [
  "Do the tiny version. It counts the same.",
  "Never miss twice — the second one is the one that matters.",
  "What time and place? Vague plans are the ones that fail.",
  "Celebrate the instant you finish. The feeling is what wires it.",
  "One missed day changes nothing. Two starts a new pattern.",
  "You are voting for the kind of person you are.",
  "If it keeps failing, redesign it. Don't just try harder.",
  "The cue does the work. Keep the place and the time still.",
  "Reduce the first step until it is almost silly.",
  "Consistency beats intensity, and it is not close.",
  "Ninety percent of a month is better than a perfect week.",
  "Put the obstacle twenty seconds further away.",
  "Bolt it onto something you already do without thinking.",
  "Progress is steepest at the start. This part is meant to be hard.",
];

export function promptOfTheDay(asOf = new Date()) {
  const index = Math.floor(startOfDay(asOf).getTime() / DAY) % PROMPTS.length;
  return PROMPTS[Math.abs(index)];
}

export function returningLine(daysAway, longestRun) {
  if (daysAway < 2) return null;
  if (daysAway <= 4) {
    return `${daysAway} days off. In the study this is built on, gaps that size left the automaticity curve untouched — pick it up where it was.`;
  }
  if (daysAway <= 14) {
    return longestRun >= 7
      ? `It has been ${daysAway} days. You have already run this ${longestRun} days straight once, which means the difficulty is not the habit.`
      : `It has been ${daysAway} days. Starting again is the ordinary case, not the failure case.`;
  }
  return "It has been a while. The useful question is not why you stopped — it is whether the design was right. Try it smaller than before.";
}

// ---------------------------------------------------------------- capture

const WEEKDAY_WORDS = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/** Next occurrence of a weekday, today counting only if `allowToday`. */
function nextWeekday(target, asOf, allowToday = false) {
  const today = startOfDay(asOf);
  let delta = (target - weekday(today) + 7) % 7;
  if (delta === 0 && !allowToday) delta = 7;
  return addDays(today, delta);
}

/**
 * Turn one sentence into either a task or a designed habit.
 *
 * Deterministic on purpose. This is the shape a language model will later fill
 * in — the parse is the contract, and having it work without a model means the
 * app is useful offline, costs nothing to run, and degrades to something
 * predictable rather than to nothing.
 */
export function parseCapture(input, asOf = new Date()) {
  const raw = input.trim();
  if (!raw) return null;
  const text = raw.toLowerCase();

  const result = {
    type: "task",
    title: raw,
    due: null,
    hasTime: false,
    priority: PRIORITY.NORMAL,
    scheduleKind: SCHEDULE.DAILY,
    weekdayMask: 127,
    timesPerWeek: 3,
    targetCount: 1,
    timerSeconds: 0,
    cue: "",
    matched: [],
  };

  let title = raw;
  const strike = (re) => {
    const m = title.match(re);
    if (m) {
      title = (title.slice(0, m.index) + title.slice(m.index + m[0].length)).replace(/\s{2,}/g, " ").trim();
      result.matched.push(m[0].trim());
    }
    return m;
  };

  // --- recurrence makes it a habit -------------------------------------
  if (/\bevery ?day\b|\bdaily\b|\beach day\b/.test(text)) {
    result.type = "habit";
    result.scheduleKind = SCHEDULE.DAILY;
    strike(/\b(every ?day|daily|each day)\b/i);
  } else if (/\bevery (week ?days?|weekday)\b|\bon weekdays\b/.test(text)) {
    result.type = "habit";
    result.scheduleKind = SCHEDULE.WEEKDAYS;
    result.weekdayMask = 0b0111110;
    strike(/\b(every (week ?days?|weekday)|on weekdays)\b/i);
  } else {
    const perWeek = text.match(/\b(\d+)\s*(?:x|times)\s*(?:a|per)\s*week\b/);
    if (perWeek) {
      result.type = "habit";
      result.scheduleKind = SCHEDULE.TIMES_PER_WEEK;
      result.timesPerWeek = Math.min(7, Math.max(1, parseInt(perWeek[1], 10)));
      strike(/\b\d+\s*(?:x|times)\s*(?:a|per)\s*week\b/i);
    } else {
      const everyDays = text.match(/\bevery (sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*(?:\s*(?:,|and|&)\s*(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*)*/);
      if (everyDays) {
        result.type = "habit";
        result.scheduleKind = SCHEDULE.WEEKDAYS;
        let mask = 0;
        for (const [word, index] of Object.entries(WEEKDAY_WORDS)) {
          if (new RegExp(`\\b${word}\\b`).test(everyDays[0])) mask |= 1 << index;
        }
        result.weekdayMask = mask || 127;
        strike(new RegExp(everyDays[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
      }
    }
  }

  // --- deadlines make it a task ----------------------------------------
  if (result.type === "task") {
    let due = null;
    if (/\btoday\b/.test(text)) { due = startOfDay(asOf); strike(/\b(due )?today\b/i); }
    else if (/\btomorrow\b/.test(text)) { due = addDays(asOf, 1); strike(/\b(due )?tomorrow\b/i); }
    else if (/\bnext week\b/.test(text)) { due = addDays(asOf, 7); strike(/\b(due )?next week\b/i); }
    else {
      const dayWord = text.match(/\b(?:due |by |on )?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/);
      if (dayWord) {
        due = nextWeekday(WEEKDAY_WORDS[dayWord[1]], asOf);
        strike(new RegExp(`\\b(?:due |by |on )?${dayWord[1]}\\b`, "i"));
      } else {
        const dateWord = text.match(/\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/);
        if (dateWord) {
          const d = new Date(asOf);
          d.setMonth(MONTHS[dateWord[2]], parseInt(dateWord[1], 10));
          d.setHours(0, 0, 0, 0);
          if (d < startOfDay(asOf)) d.setFullYear(d.getFullYear() + 1);
          due = d;
          strike(new RegExp(dateWord[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
        }
      }
    }
    if (due) result.due = due;
  }

  // --- a clock time --------------------------------------------------
  const time = title.match(/\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
            || title.match(/\bat\s*(\d{1,2}):(\d{2})\b/);
  if (time) {
    let hour = parseInt(time[1], 10);
    const minute = time[2] ? parseInt(time[2], 10) : 0;
    const suffix = (time[3] || "").toLowerCase();
    if (suffix === "pm" && hour < 12) hour += 12;
    if (suffix === "am" && hour === 12) hour = 0;
    if (result.type === "task") {
      const base = result.due ? new Date(result.due) : startOfDay(asOf);
      base.setHours(hour, minute, 0, 0);
      result.due = base;
      result.hasTime = true;
    } else {
      result.cue = `At ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}.`;
    }
    strike(new RegExp(time[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  // --- durations and counts -------------------------------------------
  const duration = title.match(/\b(\d+)\s*h(?:ours?|rs?)?\s*(\d+)?\s*(?:m|min|mins|minutes)?\b/i)
                || title.match(/\b(\d+)\s*(?:m|min|mins|minutes)\b/i);
  if (duration) {
    const isHours = /h/i.test(duration[0]);
    const a = parseInt(duration[1], 10);
    const b = duration[2] ? parseInt(duration[2], 10) : 0;
    const seconds = isHours ? a * 3600 + b * 60 : a * 60;
    if (result.type === "habit" && seconds >= 60) result.timerSeconds = seconds;
    strike(new RegExp(duration[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  const count = title.match(/\b(\d+)\s*(?:x|times)\b/i);
  if (count && result.type === "habit") {
    result.targetCount = Math.max(1, Math.min(50, parseInt(count[1], 10)));
    strike(/\b\d+\s*(?:x|times)\b/i);
  }

  // --- priority ---------------------------------------------------------
  if (/\b(urgent|important|must|asap|!!)\b/.test(text)) {
    result.priority = PRIORITY.HIGH;
    strike(/\b(urgent|important|asap|!!)\b/i);
  }

  // --- cue phrases -------------------------------------------------------
  const after = title.match(/\bafter (?:i |my |the )?([a-z0-9 '-]{3,40})/i);
  if (after && result.type === "habit") {
    result.cue = `After ${after[1].trim()}.`;
    strike(new RegExp(after[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  title = title.replace(/^\s*(?:i want to|i need to|remind me to|todo:?|task:?|habit:?)\s*/i, "");
  title = title.replace(/\s*(?:,|-|—)\s*$/, "").replace(/\s{2,}/g, " ").trim();
  result.title = title.charAt(0).toUpperCase() + title.slice(1) || raw;

  return result;
}
