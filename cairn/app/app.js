/* Cairn — app
 *
 * Plain DOM, no framework. The whole point of this surface is that it opens
 * instantly and works offline; a client framework would cost more than it
 * returns for a screen that is mostly a list.
 */

import * as E from "./engine.js";
import * as S from "./store.js";
import * as LLM from "./llm.js";

let state = S.load();
let tab = "today";
let captureDraft = "";
let redesign = null;      // last result from the model layer
let redesignBusy = false;

const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const persist = () => { S.save(state); };
const liveHabits = () => state.habits.filter((h) => !h.archivedAt).sort((a, b) => a.sortIndex - b.sortIndex);

function toast(message) {
  const host = $("#toast-host");
  host.innerHTML = `<div class="toast">${esc(message)}</div>`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { host.innerHTML = ""; }, 3200);
}

// ---------------------------------------------------------------- pieces

function ringSVG(done, total, size = 74) {
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  const progress = total ? done / total : 0;
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--faint)" stroke-width="7"></circle>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--cyan-fill)" stroke-width="7"
      stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - Math.max(0.001, progress))}"
      transform="rotate(-90 ${size / 2} ${size / 2})"></circle>
    <text x="50%" y="49%" text-anchor="middle" font-size="19" font-weight="600" fill="var(--ink)">${done}</text>
    <text x="50%" y="66%" text-anchor="middle" font-size="9.5" fill="var(--muted)">of ${total}</text>
  </svg>`;
}

function tickSVG(done, colorVar) {
  return done
    ? `<svg width="26" height="26" viewBox="0 0 26 26"><circle cx="13" cy="13" r="12" fill="var(--${colorVar}-fill, var(--cyan-fill))"></circle><path d="M7.5 13.4l3.6 3.6 7-7.4" fill="none" stroke="#FFFBF0" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"></path></svg>`
    : `<svg width="26" height="26" viewBox="0 0 26 26"><circle cx="13" cy="13" r="11.5" fill="none" stroke="var(--rule-hi)" stroke-width="2.2"></circle></svg>`;
}

function trailHTML(days, colorVar) {
  return `<span class="trail">${days.slice(-14).map((d) => {
    if (!d.counts) return `<i></i>`;
    const dim = d.state === E.STATE.REPAIRED ? ".38" : "1";
    return `<i style="background:var(--${colorVar}-fill);opacity:${dim};height:14px"></i>`;
  }).join("")}</span>`;
}

function trackHTML(habit, stats) {
  const target = Math.max(1, habit.targetCount);
  const segs = [];
  for (let i = 0; i < target; i++) {
    const on = i < stats.todayCount;
    segs.push(`<b style="${on ? `background:var(--${habit.colorToken}-fill)` : ""}"></b>`);
  }
  return `<div class="track" data-track="${habit.id}" role="slider"
      aria-label="${esc(habit.name)} progress" aria-valuemin="0" aria-valuemax="${target}"
      aria-valuenow="${stats.todayCount}" tabindex="0">
      <div class="track-in">${segs.join("")}</div></div>`;
}

function habitRow(habit) {
  const stats = E.statsFor(habit);
  const near = !stats.isDoneToday ? E.approaching(stats.currentStreak) : null;
  const counted = habit.targetCount > 1;
  const hour = new Date().getHours();

  let sub = "";
  if (stats.isDoneToday) sub = habit.reward || habit.identity || "Done.";
  else if (hour >= 20 && habit.tiny) sub = `Enough for today: ${habit.tiny}`;
  else if (habit.cue) sub = habit.cue;
  else if (habit.tiny) sub = `Tiny version: ${habit.tiny}`;
  else sub = E.scheduleSummary(habit);

  return `<div class="hrow" data-habit="${habit.id}">
    <button class="tick" data-toggle="${habit.id}" aria-label="${stats.isDoneToday ? "Undo" : "Mark done"}: ${esc(habit.name)}">
      ${tickSVG(stats.isDoneToday, habit.colorToken)}
    </button>
    <div class="hmain">
      <div class="hname ${stats.isDoneToday ? "done" : ""}">
        <span class="ic">${esc(habit.icon || "🪨")}</span>${esc(habit.name)}
      </div>
      <div class="hsub">${esc(sub)}</div>
      ${counted ? trackHTML(habit, stats) : `<div class="hmeta">${trailHTML(stats.days, habit.colorToken)}${
        near ? `<span class="pill" style="color:var(--${habit.colorToken});background:color-mix(in srgb,var(--${habit.colorToken}-fill) 14%,transparent)">${near.remaining} to ${near.milestone}</span>` : ""
      }</div>`}
    </div>
    <div class="hright">
      ${counted
        ? `<div class="streak num" style="color:var(--${habit.colorToken})">${stats.todayCount}/${habit.targetCount}</div>
           <div class="streak-u">${stats.currentStreak} ${stats.streakUnit}${stats.currentStreak === 1 ? "" : "s"}</div>`
        : (stats.currentStreak > 0
            ? `<div class="streak num" style="color:var(--${habit.colorToken})">${stats.currentStreak}</div>
               <div class="streak-u">${stats.streakUnit}${stats.currentStreak === 1 ? "" : "s"}</div>`
            : `<div class="streak-u">start</div>`)}
    </div>
  </div>`;
}

function taskRow(task) {
  const late = E.isLate(task);
  return `<div class="trow">
    <button class="tbox" data-task="${task.id}" aria-label="${task.isDone ? "Undo" : "Complete"}: ${esc(task.title)}">
      <span class="${task.isDone ? "on" : ""}"></span>
    </button>
    <span class="ttitle ${task.isDone ? "done" : ""}">${task.priority === E.PRIORITY.HIGH && !task.isDone ? "<b style='color:var(--orange)'>! </b>" : ""}${esc(task.title)}</span>
    ${task.due && !task.isDone ? `<span class="tdue ${late ? "late" : ""}">${esc(E.countdownFor(task))}</span>` : ""}
  </div>`;
}

// ---------------------------------------------------------------- today

function renderToday() {
  const now = new Date();
  const habits = liveHabits();
  const builds = habits.filter((h) => h.kind === E.KIND.BUILD && E.isScheduled(h, now));
  const done = builds.filter((h) => E.statsFor(h).isDoneToday).length;
  const todayTasks = E.tasksForToday(state.tasks);
  const resting = habits.filter((h) => h.kind === E.KIND.BUILD && !E.isScheduled(h, now));

  const m = S.meta();
  const away = m.lastOpened ? E.daysBetween(new Date(m.lastOpened), now) : 0;
  const longest = habits.reduce((a, h) => Math.max(a, E.statsFor(h).longestStreak), 0);
  const returning = E.returningLine(away, longest);

  const hour = now.getHours();
  const greet = hour < 5 ? "Still up" : hour < 12 ? "Good morning"
    : hour < 17 ? "Good afternoon" : hour < 22 ? "Good evening" : "Winding down";

  if (!habits.length && !state.tasks.length) return renderEmpty();

  view.innerHTML = `
    <section class="brief-head">
      <h1 class="greet">${greet}</h1>
      <div class="date">${now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</div>
      <div class="ring-row">
        ${ringSVG(done, builds.length)}
        <div>
          <div class="lead">${esc(E.briefLead(habits, state.tasks, now))}</div>
          ${returning ? `<div class="banner">${esc(returning)}</div>` : ""}
        </div>
      </div>
    </section>

    ${builds.length ? `<section class="card">
      <div class="row-between"><span class="section-label">Habits</span>
        <span class="section-label num">${done}/${builds.length}</span></div>
      <div style="margin-top:.4rem">${builds.map(habitRow).join("")}</div>
    </section>` : ""}

    <section class="card">
      <div class="row-between"><span class="section-label">Today's tasks</span>
        ${todayTasks.length ? `<span class="section-label num">${todayTasks.length}</span>` : ""}</div>
      <div style="margin-top:.35rem">
        ${todayTasks.length ? todayTasks.slice(0, 6).map(taskRow).join("")
          : `<p class="note" style="padding:.4rem 0">Nothing due today.</p>`}
      </div>
      <form class="capture" id="capture-form">
        <input id="capture" placeholder="Say it — “report due thursday” or “read every day after dinner”"
               autocomplete="off" value="${esc(captureDraft)}" aria-label="Capture a task or habit">
        <button class="btn" type="submit">Add</button>
      </form>
      <div id="parse-preview"></div>
    </section>

    ${resting.length ? `<section class="card">
      <span class="section-label">Resting today</span>
      <div style="margin-top:.4rem;display:flex;flex-wrap:wrap;gap:.35rem">
        ${resting.map((h) => `<span class="pill">${esc(h.icon)} ${esc(h.name)}</span>`).join("")}
      </div></section>` : ""}

    <section class="card">
      <p style="font-size:.95rem;color:var(--ink)">“${esc(E.promptOfTheDay(now))}”</p>
    </section>`;

  wireToday();
}

function renderEmpty() {
  view.innerHTML = `
    <section class="card" style="margin-top:1.4rem">
      <h2 style="font-size:1.25rem">Nothing on the pile yet</h2>
      <p style="margin-top:.5rem">Start with one or two. Every habit under construction spends the same attention, and the curve is steepest at the beginning.</p>
      <form class="capture" id="capture-form" style="margin-top:.9rem">
        <input id="capture" placeholder="“read one page every day after dinner”" autocomplete="off" aria-label="Capture">
        <button class="btn" type="submit">Add</button>
      </form>
      <div id="parse-preview"></div>
      <div style="margin-top:1rem;display:flex;gap:.5rem;flex-wrap:wrap">
        <button class="btn ghost small" id="load-example">Load a worked example</button>
        <button class="btn ghost small" id="import-here">Import from the Mac app</button>
      </div>
      <p class="note" style="margin-top:.8rem">Everything stays in this browser until you export it. No account, no server.</p>
    </section>`;
  wireToday();
  $("#load-example")?.addEventListener("click", () => {
    state = S.exampleState();
    persist();
    toast("Example loaded — clear it any time from Settings.");
    render();
  });
  $("#import-here")?.addEventListener("click", openSettings);
}

function wireToday() {
  view.querySelectorAll("[data-toggle]").forEach((el) => {
    el.addEventListener("click", () => toggleHabit(el.dataset.toggle));
  });
  view.querySelectorAll("[data-task]").forEach((el) => {
    el.addEventListener("click", () => toggleTask(el.dataset.task));
  });
  view.querySelectorAll("[data-track]").forEach(wireTrack);

  const form = $("#capture-form");
  const input = $("#capture");
  if (form && input) {
    input.addEventListener("input", () => {
      captureDraft = input.value;
      showParse(input.value);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      commitCapture(input.value);
      input.value = "";
      captureDraft = "";
      showParse("");
      input.focus();
    });
    if (captureDraft) showParse(captureDraft);
  }
}

/** Drag or click anywhere on the track to set the count. */
function wireTrack(el) {
  const habit = state.habits.find((h) => h.id === el.dataset.track);
  if (!habit) return;
  const target = Math.max(1, habit.targetCount);

  const setFrom = (clientX) => {
    const box = el.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    // A small dead zone on the left so the first segment is reachable without
    // accidentally clearing the day.
    const value = fraction < 0.04 ? 0 : Math.min(target, Math.ceil(fraction * target));
    const current = E.statsFor(habit).todayCount;
    if (value === current) return;
    S.logHabit(habit, value);
    persist();
    render();
  };

  let dragging = false;
  el.addEventListener("pointerdown", (event) => {
    dragging = true;
    el.setPointerCapture(event.pointerId);
    setFrom(event.clientX);
  });
  el.addEventListener("pointermove", (event) => { if (dragging) setFrom(event.clientX); });
  el.addEventListener("pointerup", () => { dragging = false; });
  el.addEventListener("pointercancel", () => { dragging = false; });
  el.addEventListener("keydown", (event) => {
    const current = E.statsFor(habit).todayCount;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault(); S.logHabit(habit, Math.min(target, current + 1)); persist(); render();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault(); S.logHabit(habit, Math.max(0, current - 1)); persist(); render();
    }
  });
}

function toggleHabit(id) {
  const habit = state.habits.find((h) => h.id === id);
  if (!habit) return;
  const stats = E.statsFor(habit);
  if (habit.targetCount > 1) {
    // Count habits add one at a time. Jumping from nothing to eight on a
    // single tap was the bug that made the Mac version unusable.
    S.logHabit(habit, stats.isDoneToday ? 0 : Math.min(habit.targetCount, stats.todayCount + 1));
  } else {
    S.logHabit(habit, stats.isDoneToday ? 0 : habit.targetCount);
  }
  persist();
  const after = E.statsFor(habit);
  if (after.isDoneToday && !stats.isDoneToday) {
    const milestone = E.MILESTONES.includes(after.currentStreak) ? after.currentStreak : null;
    toast(milestone ? E.milestoneNote(milestone) : `${after.currentStreak} ${after.streakUnit}${after.currentStreak === 1 ? "" : "s"} in a row.`);
  }
  render();
}

function toggleTask(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  task.isDone = !task.isDone;
  task.completedAt = task.isDone ? new Date().toISOString() : null;
  persist();
  render();
}

function showParse(text) {
  const host = $("#parse-preview");
  if (!host) return;
  const parsed = text.trim() ? E.parseCapture(text) : null;
  if (!parsed) { host.innerHTML = ""; return; }
  if (parsed.type === "habit") {
    const bits = [E.scheduleSummary(parsed)];
    if (parsed.targetCount > 1) bits.push(`${parsed.targetCount}× a day`);
    if (parsed.timerSeconds) bits.push(`${Math.round(parsed.timerSeconds / 60)} min`);
    if (parsed.cue) bits.push(parsed.cue);
    host.innerHTML = `<div class="parse">Habit · <b>${esc(parsed.title)}</b> — ${esc(bits.join(" · "))}</div>`;
  } else {
    const when = parsed.due
      ? new Date(parsed.due).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
        + (parsed.hasTime ? " " + new Date(parsed.due).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "")
      : "no date";
    host.innerHTML = `<div class="parse">Task · <b>${esc(parsed.title)}</b> — ${esc(when)}${parsed.priority === E.PRIORITY.HIGH ? " · must happen" : ""}</div>`;
  }
}

function commitCapture(text) {
  const parsed = E.parseCapture(text);
  if (!parsed || !parsed.title) return;

  if (parsed.type === "habit") {
    const habit = S.newHabit({
      name: parsed.title,
      icon: "🪨",
      colorToken: S.TOKENS[state.habits.length % S.TOKENS.length],
      cue: parsed.cue,
      scheduleKind: parsed.scheduleKind,
      weekdayMask: parsed.weekdayMask,
      timesPerWeek: parsed.timesPerWeek,
      targetCount: parsed.targetCount,
      timerSeconds: parsed.timerSeconds,
      sortIndex: state.habits.length,
    });
    state.habits.push(habit);
    persist();
    toast("Habit added. Give it a cue and a tiny version — those are the fields that matter.");
    openHabitSheet(habit.id);
    return;
  }

  state.tasks.push(S.newTask({
    title: parsed.title,
    due: parsed.due ? new Date(parsed.due).toISOString() : null,
    hasTime: parsed.hasTime,
    priority: parsed.priority,
    sortIndex: state.tasks.length,
  }));
  persist();
  render();
}

// ---------------------------------------------------------------- review

function renderReview() {
  const habits = liveHabits();
  const props = E.proposals(habits);
  const weekStart = E.startOfWeek(new Date());
  const reflection = state.reflections.find((r) => E.dayKey(r.weekStart) === E.dayKey(weekStart))
    || { weekStart: weekStart.toISOString(), wins: "", obstacles: "", tweak: "", energy: 3 };

  const due = habits.filter((h) => {
    const checks = h.checks || [];
    const stats = E.statsFor(h);
    if (stats.totalCompletions < 5) return false;
    if (!checks.length) return true;
    return E.daysBetween(new Date(checks[checks.length - 1].date), new Date()) >= 14;
  });

  view.innerHTML = `
    <section class="brief-head">
      <h1 class="greet">Review</h1>
      <div class="date">Week of ${weekStart.toLocaleDateString(undefined, { day: "numeric", month: "long" })}</div>
    </section>

    <section class="card">
      <div class="row-between">
        <span class="section-label">What the record says</span>
        <span class="section-label" style="color:var(--${redesign?.source === "model" ? "violet" : "muted"})">
          ${redesign?.source === "model" ? "written for you" : "built-in rules"}</span>
      </div>

      ${redesign?.summary ? `<p style="margin-top:.5rem;color:var(--ink)">${esc(redesign.summary)}</p>` : ""}

      ${(redesign?.proposals ?? props.map((p) => ({ title: p.title, body: p.body, why: p.why }))).length
        ? (redesign?.proposals ?? props).slice(0, 4).map((p) => `<div class="prop">
            ${p.lever ? `<span class="pill" style="margin-bottom:.3rem;color:var(--violet)">${esc(LLM.LEVER_LABEL[p.lever] || p.lever)}</span>` : ""}
            <h3>${esc(p.title)}</h3><p>${esc(p.body)}</p><p class="why">${esc(p.why)}</p></div>`).join("")
        : `<p class="note" style="margin-top:.5rem">Nothing is obviously broken. Come back after a week of data — the useful proposals need a pattern to sit on.</p>`}

      ${redesign?.error ? `<p class="note" style="margin-top:.8rem;color:var(--orange)">${esc(redesign.error)}</p>` : ""}

      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:1rem">
        <button class="btn small" id="ask-redesign" ${redesignBusy ? "disabled" : ""}>
          ${redesignBusy ? "Thinking…" : (LLM.isConfigured() ? "Ask for a redesign" : "Set up the redesign service")}</button>
        <button class="btn ghost small" id="show-digest">See what would be sent</button>
      </div>

      <p class="note" style="margin-top:.8rem">${LLM.isConfigured()
        ? "The proposals name a change to the <em>design</em> of a habit — its cue, size, schedule or friction — never a motivational line. That constraint is in the schema, not just the prompt."
        : "Right now these come from rules over your own record, not a model. That is why they work offline and cost nothing. Connecting a service makes them specific to you."}</p>
    </section>

    ${due.length ? `<section class="card">
      <span class="section-label">Automaticity check-in</span>
      <p style="margin-top:.4rem">Four questions about <b>${esc(due[0].name)}</b>. Fifteen seconds, and it is what plots the curve.</p>
      <button class="btn small" style="margin-top:.7rem" id="start-check" data-habit="${due[0].id}">Start</button>
    </section>` : ""}

    <section class="card">
      <span class="section-label">This week</span>
      <div class="field"><label for="r-wins">What went well?</label>
        <textarea id="r-wins" rows="2">${esc(reflection.wins)}</textarea></div>
      <div class="field"><label for="r-obs">Where did it break?</label>
        <textarea id="r-obs" rows="2">${esc(reflection.obstacles)}</textarea></div>
      <div class="field"><label for="r-tweak">What one thing are you changing?</label>
        <textarea id="r-tweak" rows="2">${esc(reflection.tweak)}</textarea>
        <p class="hint">One change. Shrink it, move it, re-anchor it or drop it — trying harder is not a change.</p></div>
      <button class="btn" style="margin-top:.9rem" id="save-review">Save review</button>
    </section>

    ${habits.length ? `<section class="card">
      <span class="section-label">Becoming automatic</span>
      <div style="margin-top:.6rem">${habits.map((h) => {
        const a = E.automaticityFor(h);
        return `<div style="display:flex;align-items:center;gap:.6rem;padding:.32rem 0">
          <span style="width:8.5rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);font-size:.9rem">${esc(h.icon)} ${esc(h.name)}</span>
          <span style="flex:1;height:8px;background:var(--empty);border-radius:99px;overflow:hidden;display:block">
            <span style="display:block;height:100%;width:${Math.round(a.progress * 100)}%;background:var(--${h.colorToken}-fill)"></span></span>
          <span class="num" style="font-size:.8rem;color:var(--muted);width:2rem;text-align:right">${a.current.toFixed(1)}</span>
        </div>`;
      }).join("")}</div>
      <p class="note" style="margin-top:.7rem">The bar fills toward the point where a behaviour stops needing effort. A habit that is not moving after many repetitions is telling you the cue is unstable, not that you need more discipline.</p>
    </section>` : ""}`;

  $("#save-review")?.addEventListener("click", () => {
    const next = {
      weekStart: weekStart.toISOString(),
      wins: $("#r-wins").value, obstacles: $("#r-obs").value,
      tweak: $("#r-tweak").value, energy: 3,
    };
    state.reflections = state.reflections.filter((r) => E.dayKey(r.weekStart) !== E.dayKey(weekStart));
    state.reflections.push(next);
    persist();
    toast("Review saved.");
  });
  $("#start-check")?.addEventListener("click", (event) => openCheckSheet(event.currentTarget.dataset.habit));

  $("#ask-redesign")?.addEventListener("click", async () => {
    if (!LLM.isConfigured()) { openEndpointSheet(); return; }
    redesignBusy = true; render();
    redesign = await LLM.requestProposals(state, { includeNotes: S.meta().sendNotes !== false });
    redesignBusy = false; render();
  });

  $("#show-digest")?.addEventListener("click", openDigestSheet);
}

// ---------------------------------------------------------------- manage

function renderManage() {
  const groups = E.groupTasks(state.tasks);
  const habits = liveHabits();
  const doneTasks = state.tasks.filter((t) => t.isDone);

  view.innerHTML = `
    <section class="brief-head"><h1 class="greet">Everything</h1></section>

    <section class="card">
      <div class="row-between"><span class="section-label">Habits</span>
        <button class="btn ghost small" id="new-habit">New</button></div>
      <div style="margin-top:.5rem">
        ${habits.length ? habits.map((h) => {
          const stats = E.statsFor(h);
          return `<div class="hrow">
            <div class="hmain">
              <div class="hname"><span class="ic">${esc(h.icon)}</span>${esc(h.name)}</div>
              <div class="hsub">${esc(E.scheduleSummary(h))} · ${Math.round(stats.consistency30 * 100)}% this month · best ${stats.longestStreak}</div>
              <div class="hmeta" style="margin-top:.4rem">${heatHTML(stats.days.slice(-70), h.colorToken)}</div>
            </div>
            <button class="btn ghost small" data-edit="${h.id}">Edit</button>
          </div>`;
        }).join("") : `<p class="note" style="padding:.4rem 0">No habits yet.</p>`}
      </div>
    </section>

    ${groups.map((g) => `<section class="card">
      <div class="row-between"><span class="section-label">${esc(g.title)}</span>
        <span class="section-label num">${g.tasks.length}</span></div>
      <div style="margin-top:.35rem">${g.tasks.map(taskRow).join("")}</div>
    </section>`).join("")}

    ${doneTasks.length ? `<section class="card">
      <span class="section-label">Done (${doneTasks.length})</span>
      <div style="margin-top:.35rem">${doneTasks.slice(-15).reverse().map(taskRow).join("")}</div>
    </section>` : ""}`;

  view.querySelectorAll("[data-task]").forEach((el) =>
    el.addEventListener("click", () => toggleTask(el.dataset.task)));
  view.querySelectorAll("[data-edit]").forEach((el) =>
    el.addEventListener("click", () => openHabitSheet(el.dataset.edit)));
  $("#new-habit")?.addEventListener("click", () => {
    const habit = S.newHabit({
      name: "New habit",
      colorToken: S.TOKENS[state.habits.length % S.TOKENS.length],
      sortIndex: state.habits.length,
    });
    state.habits.push(habit);
    persist();
    openHabitSheet(habit.id);
  });
}

function heatHTML(days, colorVar) {
  const cols = [];
  for (let i = 0; i < days.length; i += 7) {
    const week = days.slice(i, i + 7);
    cols.push(`<span class="col">${week.map((d) => {
      if (!d.counts) return `<i></i>`;
      const dim = d.state === E.STATE.REPAIRED ? ".35" : "1";
      return `<i style="background:var(--${colorVar}-fill);opacity:${dim}"></i>`;
    }).join("")}</span>`);
  }
  return `<span class="heat">${cols.join("")}</span>`;
}

// ---------------------------------------------------------------- sheets

function closeSheet() { $("#sheet-host").innerHTML = ""; }

function openSheet(html) {
  const host = $("#sheet-host");
  host.innerHTML = `<div class="sheet-bg" id="sheet-bg"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  $("#sheet-bg").addEventListener("click", (event) => {
    if (event.target.id === "sheet-bg") closeSheet();
  });
  document.addEventListener("keydown", function onEsc(event) {
    if (event.key === "Escape") { closeSheet(); document.removeEventListener("keydown", onEsc); }
  });
}

function openHabitSheet(id) {
  const habit = state.habits.find((h) => h.id === id);
  if (!habit) return;

  openSheet(`
    <h2>Design this habit</h2>
    <p class="note">A habit that has not been designed is a wish. These four fields are the machinery.</p>

    <div class="field"><label for="h-name">Name</label><input id="h-name" value="${esc(habit.name)}"></div>

    <div class="field"><label>Icon</label>
      <div class="chips" id="h-icons">${S.EMOJI.map((e) =>
        `<button type="button" data-emoji="${e}" aria-pressed="${habit.icon === e}">${e}</button>`).join("")}</div></div>

    <div class="field"><label>Colour</label>
      <div class="swatches" id="h-colors">${S.TOKENS.map((t) =>
        `<button type="button" data-token="${t}" aria-pressed="${habit.colorToken === t}"
          style="background:var(--${t}-fill)" aria-label="${t}"></button>`).join("")}</div></div>

    <div class="field"><label for="h-cue">Cue — when and where</label>
      <input id="h-cue" value="${esc(habit.cue)}" placeholder="After I get into bed, before my phone.">
      <p class="hint">Highest-return field here. In the classic trial, writing this one sentence took exercise adherence from 35% to 91%.</p></div>

    <div class="field"><label for="h-tiny">Tiny version</label>
      <input id="h-tiny" value="${esc(habit.tiny)}" placeholder="One page.">
      <p class="hint">The version that survives your worst day. A floor, never a ceiling.</p></div>

    <div class="field"><label for="h-identity">Identity</label>
      <input id="h-identity" value="${esc(habit.identity)}" placeholder="I am someone who reads every day."></div>

    <div class="field"><label for="h-reward">Celebration</label>
      <input id="h-reward" value="${esc(habit.reward)}" placeholder="Say “good” out loud.">
      <p class="hint">It has to land within seconds. What predicts sticking with a goal is enjoying it while doing it, not valuing the payoff.</p></div>

    <div class="field"><label for="h-sched">Repeat</label>
      <select id="h-sched">
        <option value="0" ${habit.scheduleKind === 0 ? "selected" : ""}>Every day</option>
        <option value="1" ${habit.scheduleKind === 1 ? "selected" : ""}>Certain days</option>
        <option value="2" ${habit.scheduleKind === 2 ? "selected" : ""}>X times a week</option>
      </select></div>

    <div class="field" id="h-days-field" ${habit.scheduleKind === 1 ? "" : 'style="display:none"'}>
      <label>Days</label>
      <div class="chips" id="h-days">${E.WEEKDAY_SHORT.map((d, i) =>
        `<button type="button" data-day="${i}" aria-pressed="${(habit.weekdayMask & (1 << i)) !== 0}">${d}</button>`).join("")}</div></div>

    <div class="field" id="h-week-field" ${habit.scheduleKind === 2 ? "" : 'style="display:none"'}>
      <label for="h-week">Times a week</label>
      <input id="h-week" type="number" min="1" max="7" value="${habit.timesPerWeek}"></div>

    <div class="field"><label for="h-target">Times a day</label>
      <input id="h-target" type="number" min="1" max="50" value="${habit.targetCount}">
      <p class="hint">Above one you get a draggable progress track instead of a single tick.</p></div>

    <div class="sheet-actions">
      <button class="btn ghost" id="h-delete">Delete</button>
      <button class="btn" id="h-save">Save</button>
    </div>`);

  const sheet = $("#sheet-host");
  sheet.querySelectorAll("#h-icons button").forEach((b) => b.addEventListener("click", () => {
    sheet.querySelectorAll("#h-icons button").forEach((o) => o.setAttribute("aria-pressed", "false"));
    b.setAttribute("aria-pressed", "true");
  }));
  sheet.querySelectorAll("#h-colors button").forEach((b) => b.addEventListener("click", () => {
    sheet.querySelectorAll("#h-colors button").forEach((o) => o.setAttribute("aria-pressed", "false"));
    b.setAttribute("aria-pressed", "true");
  }));
  sheet.querySelectorAll("#h-days button").forEach((b) => b.addEventListener("click", () => {
    b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
  }));
  $("#h-sched").addEventListener("change", (event) => {
    const value = Number(event.target.value);
    $("#h-days-field").style.display = value === 1 ? "" : "none";
    $("#h-week-field").style.display = value === 2 ? "" : "none";
  });

  $("#h-delete").addEventListener("click", () => {
    state.habits = state.habits.filter((h) => h.id !== habit.id);
    persist(); closeSheet(); render(); toast("Deleted.");
  });

  $("#h-save").addEventListener("click", () => {
    habit.name = $("#h-name").value.trim() || habit.name;
    habit.icon = sheet.querySelector('#h-icons button[aria-pressed="true"]')?.dataset.emoji || habit.icon;
    habit.colorToken = sheet.querySelector('#h-colors button[aria-pressed="true"]')?.dataset.token || habit.colorToken;
    habit.cue = $("#h-cue").value.trim();
    habit.tiny = $("#h-tiny").value.trim();
    habit.identity = $("#h-identity").value.trim();
    habit.reward = $("#h-reward").value.trim();
    habit.scheduleKind = Number($("#h-sched").value);
    let mask = 0;
    sheet.querySelectorAll('#h-days button[aria-pressed="true"]').forEach((b) => { mask |= 1 << Number(b.dataset.day); });
    habit.weekdayMask = mask || 127;
    habit.timesPerWeek = Math.max(1, Math.min(7, Number($("#h-week").value) || 3));
    habit.targetCount = Math.max(1, Math.min(50, Number($("#h-target").value) || 1));
    persist(); closeSheet(); render();
  });
}

function openCheckSheet(id) {
  const habit = state.habits.find((h) => h.id === id);
  if (!habit) return;
  const answers = [4, 4, 4, 4];
  let step = 0;

  const draw = () => {
    openSheet(`
      <p class="section-label" style="color:var(--${habit.colorToken})">${esc(habit.name)}</p>
      <h2 style="margin-top:.3rem">${esc(E.SRBAI_PROMPTS[step])}</h2>
      <div class="scale" id="scale">${[1, 2, 3, 4, 5, 6, 7].map((n) =>
        `<button type="button" data-v="${n}" aria-pressed="${answers[step] === n}">${n}</button>`).join("")}</div>
      <div class="scale-ends"><span>strongly disagree</span><span>strongly agree</span></div>
      <p class="note" style="margin-top:1rem">Four items from the Self-Report Behavioural Automaticity Index (Gardner et al., 2012). Answering honestly matters more than answering well.</p>
      <div class="sheet-actions">
        <button class="btn ghost" id="c-cancel">Cancel</button>
        <button class="btn" id="c-next">${step === 3 ? "Save" : "Next"}</button>
      </div>`);

    $("#scale").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      answers[step] = Number(b.dataset.v);
      $("#scale").querySelectorAll("button").forEach((o) => o.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
    }));
    $("#c-cancel").addEventListener("click", closeSheet);
    $("#c-next").addEventListener("click", () => {
      if (step < 3) { step += 1; draw(); return; }
      S.addCheck(habit, answers);
      persist(); closeSheet(); render();
      toast(E.automaticityVerdict(answers.reduce((a, b) => a + b, 0) / 4));
    });
  };
  draw();
}

/**
 * Show the digest in full before it goes anywhere.
 *
 * A product that claims a privacy position has to be able to show exactly what
 * it transmits. This is that screen, and it is reachable before you ever send
 * anything.
 */
function openDigestSheet() {
  const sendNotes = S.meta().sendNotes !== false;
  const digest = LLM.buildDigest(state, { includeNotes: sendNotes });
  const text = JSON.stringify(digest, null, 2);

  openSheet(`
    <h2>What gets sent</h2>
    <p class="note">This exact JSON, to your own service, once when you ask for a redesign. Nothing else leaves the device, and nothing is stored at the other end.</p>

    <div class="field" style="margin-top:1rem">
      <label style="display:flex;align-items:center;gap:.5rem;cursor:pointer">
        <input type="checkbox" id="send-notes" ${sendNotes ? "checked" : ""} style="width:auto">
        <span>Include my notes and moods</span>
      </label>
      <p class="hint">Notes carry the <em>reason</em> a habit failed, which no statistic does, so the proposals are noticeably better with them. They are also the most personal thing here. Your call.</p>
    </div>

    <div class="field">
      <label>${text.length.toLocaleString()} characters</label>
      <textarea readonly rows="14" style="font-family:ui-monospace,Menlo,monospace;font-size:.75rem">${esc(text)}</textarea>
    </div>

    <div class="sheet-actions">
      <button class="btn ghost" id="copy-digest">Copy</button>
      <button class="btn" id="digest-done">Done</button>
    </div>`);

  $("#send-notes").addEventListener("change", (event) => {
    S.setMeta({ sendNotes: event.target.checked });
    openDigestSheet();
  });
  $("#copy-digest").addEventListener("click", () => {
    navigator.clipboard?.writeText(text);
    toast("Copied.");
  });
  $("#digest-done").addEventListener("click", closeSheet);
}

function openEndpointSheet() {
  openSheet(`
    <h2>Connect the redesign service</h2>
    <p class="note">The proposals get written for you rather than picked from rules. This needs a small service of your own because an API key must never live in a browser.</p>

    <div class="field" style="margin-top:1rem">
      <label for="ep">Service URL</label>
      <input id="ep" placeholder="https://cairn-redesign.you.workers.dev" value="${esc(S.meta().llmEndpoint || "")}">
      <p class="hint">Deploy <code>worker/</code> from the repo: <code>npx wrangler secret put ANTHROPIC_API_KEY</code> then <code>npx wrangler deploy</code>. It prints this URL. Roughly a cent per person per month at one review a week.</p>
    </div>

    <div class="sheet-actions">
      <button class="btn ghost" id="ep-clear">Disconnect</button>
      <button class="btn" id="ep-save">Save</button>
    </div>`);

  $("#ep-save").addEventListener("click", () => {
    const value = $("#ep").value.trim();
    S.setMeta({ llmEndpoint: value });
    closeSheet(); render();
    toast(value ? "Connected. Ask for a redesign." : "Cleared.");
  });
  $("#ep-clear").addEventListener("click", () => {
    S.setMeta({ llmEndpoint: "" });
    closeSheet(); render();
  });
}

function openSettings() {
  const habits = state.habits.length;
  const days = state.habits.reduce((a, h) => a + (h.entries || []).length, 0);

  openSheet(`
    <h2>Your data</h2>
    <p class="note">${habits} habit${habits === 1 ? "" : "s"}, ${days} logged day${days === 1 ? "" : "s"}, ${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"} — all in this browser.</p>

    <div class="sheet-actions" style="margin-top:1rem">
      <button class="btn ghost" id="do-export">Export JSON</button>
      <button class="btn ghost" id="do-import">Import JSON</button>
    </div>
    <input type="file" id="file" accept="application/json,.json" class="hidden">
    <p class="note" style="margin-top:.7rem">The same format the Mac app reads and writes, so a file moves either way. Import is additive and safe to run twice — matched on id, never duplicating, never deleting.</p>

    <div class="field" style="margin-top:1.4rem">
      <label>Appearance</label>
      <select id="theme">
        <option value="auto">Follow system</option>
        <option value="light">Paper</option>
        <option value="dark">Ink</option>
      </select>
    </div>

    <div class="field" style="margin-top:1.4rem">
      <label>Redesign service</label>
      <button class="btn ghost small" id="s-endpoint" style="margin-top:.2rem">
        ${LLM.isConfigured() ? "Connected — change or disconnect" : "Not connected — set it up"}</button>
      <p class="hint">Optional. Without it the weekly proposals come from built-in rules, which work offline.</p>
    </div>

    <div class="sheet-actions" style="margin-top:1.4rem">
      <button class="btn ghost" id="do-example">Load example</button>
      <button class="btn ghost" id="do-clear" style="color:var(--red)">Erase everything</button>
    </div>
    <p class="note" style="margin-top:.7rem">Erasing is immediate and cannot be undone. Export first.</p>
    <div class="sheet-actions"><button class="btn" id="s-close">Done</button></div>`);

  const themeSelect = $("#theme");
  themeSelect.value = S.meta().theme || "auto";
  themeSelect.addEventListener("change", () => {
    S.setMeta({ theme: themeSelect.value });
    applyTheme();
  });

  $("#s-close").addEventListener("click", closeSheet);
  $("#s-endpoint").addEventListener("click", openEndpointSheet);

  $("#do-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(S.toPayload(state), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Cairn-${E.dayKey(new Date())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $("#do-import").addEventListener("click", () => $("#file").click());
  $("#file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const { payload, error } = S.decodePayload(await file.text());
    if (error) { toast(error); return; }
    const { report, version } = S.mergePayload(state, payload);
    persist(); closeSheet(); render();
    toast(S.summariseReport(report, version));
  });

  $("#do-example").addEventListener("click", () => {
    state = S.exampleState(); persist(); closeSheet(); render();
    toast("Example loaded.");
  });

  $("#do-clear").addEventListener("click", () => {
    if (!confirm("Erase every habit, task and logged day? This cannot be undone.")) return;
    state = { habits: [], tasks: [], reflections: [] };
    persist(); closeSheet(); render();
  });
}

// ---------------------------------------------------------------- shell

function applyTheme() {
  const choice = S.meta().theme || "auto";
  if (choice === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", choice);
}

function render() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.setAttribute("aria-selected", String(t.dataset.tab === tab)));
  if (tab === "today") renderToday();
  else if (tab === "review") renderReview();
  else renderManage();
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    if (t.dataset.tab !== "review") redesign = null;
    tab = t.dataset.tab; window.scrollTo(0, 0); render();
  }));
$("#open-settings").addEventListener("click", openSettings);

applyTheme();
render();
// Recorded after the first render so "days away" reflects the gap, not zero.
S.setMeta({ lastOpened: new Date().toISOString() });
