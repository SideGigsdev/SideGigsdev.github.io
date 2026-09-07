/* Cairn web — engine assertions.
 *
 * The same rules the Swift engine asserts, checked against the JS port. If
 * these drift the two apps quietly disagree about what a streak is, which is
 * worse than either being wrong on its own.
 *
 * Run: node web/app/tests.mjs
 */
import * as E from "./engine.js";
import * as S from "./store.js";

let failures = [];
const ok = (cond, msg) => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) failures.push(msg);
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);

const TODAY = new Date(2026, 8, 7, 12, 0, 0); // a fixed Monday noon
const back = (n) => E.addDays(TODAY, -n);

function habit(over = {}) {
  return S.newHabit({ name: "Test", createdAt: E.addDays(TODAY, -120).toISOString(), ...over });
}
function log(h, daysAgo, count = 1, repair = false) {
  h.entries.push({ day: E.dayKey(back(daysAgo)), count, note: "", mood: null, isRepair: repair, durationSeconds: 0 });
}

console.log("streaks");
{
  const a = habit();
  for (let i = 0; i < 5; i++) log(a, i);
  eq(E.currentStreak(E.daysFor(a, 30, TODAY)), 5, "five consecutive days count as five");

  const b = habit();
  for (let i = 1; i <= 4; i++) log(b, i);
  eq(E.currentStreak(E.daysFor(b, 30, TODAY)), 4, "an unfinished today carries yesterday's streak");

  const c = habit();
  [0, 1, 3, 4, 5].forEach((i) => log(c, i));
  eq(E.currentStreak(E.daysFor(c, 30, TODAY)), 2, "a missed day ends the current run");
  eq(E.longestStreak(E.daysFor(c, 30, TODAY)), 3, "the longest run survives the gap");

  const d = habit();
  [0, 1, 3, 4, 5].forEach((i) => log(d, i));
  log(d, 2, 1, true);
  eq(E.currentStreak(E.daysFor(d, 30, TODAY)), 6, "a repair bridges a single missed day");

  const today = E.weekday(TODAY);
  const e = habit({ scheduleKind: E.SCHEDULE.WEEKDAYS, weekdayMask: (1 << today) | (1 << ((today + 6) % 7)) });
  [0, 1, 7].forEach((i) => log(e, i));
  eq(E.currentStreak(E.daysFor(e, 30, TODAY)), 3, "unscheduled days neither extend nor break a run");

  const f = habit({ targetCount: 3 });
  log(f, 0, 2);
  const days = E.daysFor(f, 30, TODAY);
  eq(days[days.length - 1].state, E.STATE.PARTIAL, "two of three reps is partial, not done");
  eq(E.currentStreak(days), 0, "a partial day does not count");
}

console.log("consistency");
{
  const a = habit();
  for (let i = 0; i < 30; i += 2) log(a, i);
  const rate = E.consistency(E.daysFor(a, 30, TODAY), 30, a);
  ok(Math.abs(rate - 0.5) < 0.02, `every other day is about 50% — got ${rate.toFixed(3)}`);

  const b = habit({ scheduleKind: E.SCHEDULE.TIMES_PER_WEEK, timesPerWeek: 3 });
  for (let w = 0; w < 4; w++) for (let d = 0; d < 3; d++) log(b, w * 7 + d);
  ok(E.consistency(E.daysFor(b, 28, TODAY), 28, b) > 0.95, "meeting a 3x/week quota reads as full consistency");
  ok(E.weekStreak(b, E.daysFor(b, 28, TODAY), TODAY) >= 3, "consecutive quota weeks accumulate");
}

console.log("automaticity");
{
  ok(Math.abs(E.autoValue(0, 22) - 1) < 1e-6, "the curve starts at the floor");
  ok(E.autoValue(1000, 22) > 6.99 && E.autoValue(1000, 22) <= 7, "it approaches the ceiling but never exceeds it");
  const fraction = (E.autoValue(66, E.AUTO.PRIOR_RATE) - 1) / 6;
  ok(fraction > 0.93 && fraction < 0.97, `66 reps lands near 95% of the plateau — got ${fraction.toFixed(3)}`);
  ok(Math.abs(E.autoValue(E.autoReps(5.5, 22), 22) - 5.5) < 1e-6, "autoReps inverts autoValue");

  const h = habit();
  for (let i = 1; i <= 60; i++) log(h, i);
  h.checks = [8, 16, 24, 40, 60].map((n) => ({
    date: back(60 - n).toISOString(), score: E.autoValue(n, 12), a1: 0, a2: 0, a3: 0, a4: 0,
  }));
  const fit = E.automaticityFor(h);
  ok(fit.personalised, "five clean readings personalise the curve");
  ok(Math.abs(fit.rate - 12) < 1.5, `the fit recovers the true rate — got ${fit.rate.toFixed(2)}`);

  const thin = habit();
  log(thin, 1);
  thin.checks = [{ date: back(1).toISOString(), score: 3, a1: 3, a2: 3, a3: 3, a4: 3 }];
  ok(!E.automaticityFor(thin).personalised, "one reading is not enough to fit");
  eq(E.automaticityFor(thin).rate, E.AUTO.PRIOR_RATE, "a thin history keeps the published prior");
}

console.log("goal gradient");
{
  ok(E.approaching(5) !== null, "5 is within three of the 7 milestone");
  ok(E.approaching(8) === null, "8 is too far from 14 to pull");
  ok(E.approaching(0) === null, "a streak of zero has no gradient");
  eq(E.approaching(29), { remaining: 1, milestone: 30 }, "29 approaches 30");
}

console.log("tasks");
{
  const task = (dueIn, over = {}) => S.newTask({
    title: "T", due: dueIn === null ? null : E.addDays(TODAY, dueIn).toISOString(), ...over,
  });
  eq(E.bucketFor(task(-3), TODAY), E.BUCKET.OVERDUE, "three days ago is late");
  eq(E.bucketFor(task(0), TODAY), E.BUCKET.TODAY, "today is today");
  eq(E.bucketFor(task(1), TODAY), E.BUCKET.TOMORROW, "tomorrow is tomorrow");
  eq(E.bucketFor(task(4), TODAY), E.BUCKET.THIS_WEEK, "four days out is this week");
  eq(E.bucketFor(task(30), TODAY), E.BUCKET.LATER, "a month out is later");
  eq(E.bucketFor(task(null), TODAY), E.BUCKET.SOMEDAY, "an undated task has no deadline bucket");

  const missed = S.newTask({ title: "T", due: new Date(2026, 8, 7, 9, 0).toISOString(), hasTime: true });
  eq(E.bucketFor(missed, new Date(2026, 8, 7, 20, 0)), E.BUCKET.OVERDUE,
     "a timed deadline passed earlier today is late");

  const all = [task(30), task(null), task(0), task(-3), task(1)];
  eq(E.tasksForToday(all, TODAY).length, 2, "only late and due-today reach the day view");
  ok(E.isLate(E.tasksForToday(all, TODAY)[0], TODAY), "late items come first");

  const urgent = task(0, { priority: E.PRIORITY.HIGH, title: "Urgent" });
  eq(E.orderTasks([task(0), urgent])[0].title, "Urgent", "high priority sorts above normal");
  eq(E.countdownFor(task(0), TODAY), "Today", "today reads as Today");
  ok(E.countdownFor(task(-3), TODAY).includes("3 days late"), "lateness is stated plainly in days");
}

console.log("capture");
{
  const p1 = E.parseCapture("report due thursday", TODAY);
  eq(p1.type, "task", "a deadline makes it a task");
  eq(E.weekday(p1.due), 4, "thursday resolves to the next Thursday");
  ok(!/thursday/i.test(p1.title), `the date is stripped from the title — got "${p1.title}"`);

  const p2 = E.parseCapture("read every day after dinner", TODAY);
  eq(p2.type, "habit", "a recurrence makes it a habit");
  eq(p2.scheduleKind, E.SCHEDULE.DAILY, "every day is daily");
  ok(p2.cue.toLowerCase().includes("dinner"), `the cue is captured — got "${p2.cue}"`);
  eq(p2.title, "Read", `the title is what is left — got "${p2.title}"`);

  const p3 = E.parseCapture("gym 3 times a week", TODAY);
  eq(p3.scheduleKind, E.SCHEDULE.TIMES_PER_WEEK, "a quota is recognised");
  eq(p3.timesPerWeek, 3, "the quota number is read");

  const p4 = E.parseCapture("programming 1h15 every day", TODAY);
  eq(p4.timerSeconds, 4500, "1h15 becomes 4500 seconds");

  const p5 = E.parseCapture("water 8 times every day", TODAY);
  eq(p5.targetCount, 8, "a daily count is read");

  const p6 = E.parseCapture("urgent: call the bank tomorrow", TODAY);
  eq(p6.priority, E.PRIORITY.HIGH, "urgency is recognised");
  eq(E.daysBetween(TODAY, p6.due), 1, "tomorrow is tomorrow");

  const p7 = E.parseCapture("standup at 9am every weekday", TODAY);
  eq(p7.scheduleKind, E.SCHEDULE.WEEKDAYS, "weekdays are recognised");
  eq(p7.weekdayMask, 0b0111110, "the weekday mask is Mon-Fri");
  ok(p7.cue.includes("09:00"), `a clock time becomes the cue — got "${p7.cue}"`);

  ok(E.parseCapture("   ", TODAY) === null, "empty input parses to nothing");
}

console.log("transfer");
{
  const state = S.exampleState();
  const payload = S.toPayload(state);
  eq(payload.version, 2, "the payload declares version 2");
  ok(payload.habits.length === 3, "every habit is exported");

  const round = JSON.parse(JSON.stringify(payload));
  const fresh = { habits: [], tasks: [], reflections: [] };
  const { report } = S.mergePayload(fresh, round);
  eq(report.habitsAdded, 3, "importing into an empty store adds every habit");
  eq(fresh.habits[0].name, state.habits[0].name, "names survive the round trip");
  eq(fresh.habits[0].entries.length, state.habits[0].entries.length, "logged days survive");
  eq(fresh.habits[0].cue, state.habits[0].cue, "the cue survives");
  eq(fresh.habits[1].targetCount, 8, "a daily target survives");
  eq(fresh.habits[0].checks.length, 3, "automaticity check-ins survive");
  eq(fresh.tasks.length, state.tasks.length, "tasks survive");

  // Idempotence is the property that matters: running the same file twice
  // must change nothing the second time.
  const second = S.mergePayload(fresh, round);
  eq(second.report.habitsAdded, 0, "a second import adds no habits");
  eq(second.report.entriesAdded, 0, "a second import adds no days");
  eq(second.report.tasksAdded, 0, "a second import adds no tasks");

  const bad = S.decodePayload("not json");
  ok(!!bad.error, "nonsense is rejected with a reason");
  const legacy = S.decodePayload(JSON.stringify({
    exportedAt: "2026-01-01T00:00:00Z",
    habits: [{ name: "Read", kind: "Build", identity: "", cue: "After coffee.", tiny: "One page.",
      reward: "", friction: "", schedule: "Every day", createdAt: "2025-12-01T00:00:00Z",
      entries: [{ day: "2025-12-02T00:00:00Z", count: 1, repaired: false, note: "" }],
      automaticity: [], urges: [] }],
  }));
  ok(!legacy.error && legacy.payload.version === 1, "a version 1 export is still readable");
}

console.log("proposals");
{
  const h = habit({ name: "Reading", cue: "" });
  // Fails every Thursday for ten weeks, otherwise solid.
  for (let i = 1; i < 70; i++) {
    if (E.weekday(back(i)) === 4) continue;
    log(h, i);
  }
  const props = E.proposals([h], TODAY);
  ok(props.some((p) => /Thursdays/.test(p.title)), "a weekday pattern is named");
  ok(props.every((p) => p.why && p.why.length > 10), "every proposal states its reasoning");
  ok(props.every((p) => !/you can do it|great job|keep going/i.test(p.body)),
     "no proposal is a motivational line");
}

console.log("");
if (failures.length) {
  console.log(`${failures.length} FAILED:`);
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("All web engine checks passed.");
