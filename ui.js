// ui.js -- RAW GAME 13.52 loader UI: step tracker, progress bar, log console.
//
// One module drives BOTH pages: index.html (boot / firmware gate) and jb.html
// (the exploit run). It is deliberately defensive -- every element is optional,
// so the same code works on the landing page, on the run page, and inside the
// offline replay harness used for testing.
//
// Performance rules this file follows, because it runs on the PS4's WebKit
// while the exploit is holding ~137 MB of pinned heap:
//   * Every DOM mutation is queued and flushed once per animation frame. A run
//     emits 400+ events; touching the DOM 400 times forces 400 layouts on a
//     slow engine, so they are coalesced into ~1 layout per frame.
//   * The log console caps its node count and drops from the front, so a long
//     run cannot grow the DOM without bound.
//   * Network logging is OFF unless ?net=1, and even then it is BATCHED into
//     one request per flush. The original build opened a fresh XHR for every
//     single log line, which on its own cost hundreds of round trips.

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Step table
// ---------------------------------------------------------------------------
// `w` is the weight of the step in the overall bar. The run has a fixed shape,
// so weights are hand-tuned to reflect real cost: the primitive and the race
// pool dominate wall-clock, so they carry the most weight and therefore show
// the most bar movement.
// BOOT_STEPS is the landing page's two-step bar. BOOT_MODE switches the bar
// over to it; without that switch the landing page would draw a 15-step list of
// which only two can ever light up, which reads as a broken progress bar.
const BOOT_STEPS = [
  { id: "boot", label: "Firmware check", w: 1 },
  { id: "warm", label: "Warming assets", w: 1 },
];

const FULL_STEPS = [
  { id: "boot", label: "Firmware check", w: 2 },
  { id: "warm", label: "Warming assets", w: 3 },
  { id: "prim", label: "Arbitrary R/W primitive", w: 18 },
  { id: "bases", label: "Leaking module bases", w: 6 },
  { id: "gadgets", label: "Gadget + syscall table", w: 5 },
  { id: "chain", label: "Syscall chain", w: 4 },
  { id: "pool", label: "Kernel race pool", w: 16 },
  { id: "kbase", label: "Kernel base discovery", w: 8 },
  { id: "krw", label: "Kernel read/write tests", w: 6 },
  { id: "jb", label: "Jailbreak", w: 10 },
  { id: "kpatch", label: "Kernel patch", w: 5 },
  { id: "payload", label: "Payload injection", w: 8 },
  { id: "caps", label: "Capabilities + kern.file", w: 4 },
  { id: "cleanup", label: "Teardown + restore", w: 3 },
  { id: "report", label: "Report", w: 2 },
];

// Which step table the bar is currently using.
let BOOT_MODE = false;
export let STEPS = FULL_STEPS;
let TOTAL_W = 0;
let WEIGHT_BEFORE = [];

// Switch to the landing page's short step list. The current step is remapped
// by id so a switch mid-run cannot lose the bar's position.
export function useBootSteps() {
  if (BOOT_MODE) return;
  BOOT_MODE = true;
  reweight(BOOT_STEPS);
}

// Switch back to the run's full step list. The counterpart to useBootSteps().
//
// The landing page now runs the exploit in its own document instead of
// navigating to jb.html, so the bar has to grow from two steps to fifteen
// without the DOM being torn down and rebuilt underneath it. BOOT_STEPS is a
// prefix of FULL_STEPS -- same "boot" and "warm" ids, different weights -- so
// reweight() carries the position straight across: mid-"Warming assets" at 1/2
// becomes 2/15, still on "Warming assets", and the run's first step() advances
// it from there. Nothing to remap and no flash of an unrelated step name.
export function useRunSteps() {
  if (!BOOT_MODE) return;
  BOOT_MODE = false;
  reweight(FULL_STEPS);
}

function computeWeights(table) {
  TOTAL_W = table.reduce(function (a, s) {
    return a + s.w;
  }, 0);
  const before = [];
  let acc = 0;
  for (let i = 0; i < table.length; i++) {
    before[i] = acc;
    acc += table[i].w;
  }
  return before;
}

// Swap the active step table. Only ever called after S exists (from
// useBootSteps / init), so it can safely read the current position and carry
// it over to the matching step id in the new table.
function reweight(table) {
  const keepId = STEPS[S.stepIndex] ? STEPS[S.stepIndex].id : null;
  STEPS = table;
  WEIGHT_BEFORE = computeWeights(table);
  STEP_INDEX = {};
  for (let i = 0; i < table.length; i++) STEP_INDEX[table[i].id] = i;
  if (keepId !== null) {
    const i = table.findIndex(function (s) {
      return s.id === keepId;
    });
    if (i >= 0) S.stepIndex = i;
  }
  if (S.booted) {
    paintSteps();
    // The step count in the header is part of the clock tick, so without this
    // it would keep saying "/2" for up to 200ms after a table switch. Not a bug
    // -- it self-corrects -- but it is exactly the sort of stale-looking frame
    // that makes a fast hand-off read as a slow one.
    flushClock();
  }
}

// STEP_INDEX and the weight table are rebuilt together, because the two step
// lists (boot vs run) have different lengths. This runs before S exists, so it
// only touches module-level state -- never the state object.
let STEP_INDEX = {};
(function initTables() {
  WEIGHT_BEFORE = computeWeights(FULL_STEPS);
  for (let i = 0; i < FULL_STEPS.length; i++)
    STEP_INDEX[FULL_STEPS[i].id] = i;
})();

// ---------------------------------------------------------------------------
// Log classification
// ---------------------------------------------------------------------------
const RE_BAD =
  /FAIL|ERROR|THREW|REBOOT|MISS|LOST|POISON|TIMEOUT|MISMATCH|ABORT|GIVEUP|GIVE-UP|NO-STORAGE|UNSEEN|DENIED|REFUS|BROKEN/i;
const RE_WARN =
  /WARN|SKIP|REFUS|COMMITTED|DIRTY|RETRY|RELOAD|GIVEUP|DEGRADED|UNVERIFIED|UNUSED/i;
const RE_OK =
  /\bOK\b|\bPASS\b|PASS=|ACHIEVED|RUNNING|ARMED|JAILBROKEN|PATCHED|PROVEN|LIVE|WIN\b|DONE/i;
const RE_STEP = /^(PHASE|STEP|PRIMITIVE-OK|BASES|STUBS|JB-|KPATCH|PAYLOAD|KRW|EG-|KF-)/i;
const RE_PROOF = /^PROOF-(OK|FAIL)$/;

// tag -> the step it belongs to. Lets any part of the run report progress by
// emitting a normal log line, without every call site having to know the step
// machinery exists. Order matters: first match wins.
const TAG_STEP = [
  [/^BUILD$|^FW$|^FW-STATUS$|^FW-KTABLE$|^GATE/, "boot"],
  [/^WARM|^ASSET|^PREFETCH/, "warm"],
  [/^(ADDROF|LOAD|GROOM|COMPOSE|CAPTURE|CARRIER|CANDIDATE|IDENTITY|PIN-|FAKE|CELL|LEAK|HISTORY|COMPOSITION|STRUCTURE|SETTLE|SETTLED|ATTEMPT|RETRY)/, "prim"],
  [/^BASES/, "bases"],
  [/^(GADGET|STUBS|SYSCALL)/, "gadgets"],
  [/^(CH-|JB-PROBE|JB-ALREADY|WORKER)/, "chain"],
  [/^(PR-|AIO|SWEEP|POOL|AMORT|REAP|NEUTRAL|GATE)/, "pool"],
  [/^(KERN|KF-|SYSCTL|OID|KBASE)/, "kbase"],
  [/^(KRW)/, "krw"],
  [/^(JB-)/, "jb"],
  [/^(KPATCH|KEXEC|SYSENT|SITE)/, "kpatch"],
  [/^(PAYLOAD|PTHREAD)/, "payload"],
  [/^(CAPS)/, "caps"],
  [/^(THREW|CLOSE|PIN-RESTORE|EXPM1|DISARM|STRAGGLERS|PROOF-SUMMARY)/, "cleanup"],
];

function levelFor(tag, detail) {
  const t = String(tag || "");
  const d = String(detail == null ? "" : detail);
  const s = t + " " + d;
  if (RE_BAD.test(s)) return "bad";
  if (RE_PROOF.test(t)) return t === "PROOF-FAIL" ? "bad" : "ok";
  if (RE_WARN.test(s)) return "warn";
  if (RE_OK.test(t)) return "ok";
  if (RE_STEP.test(t)) return "head";
  return "info";
}

function stepForTag(tag) {
  const t = String(tag || "");
  for (let i = 0; i < TAG_STEP.length; i++)
    if (TAG_STEP[i][0].test(t)) return TAG_STEP[i][1];
  return null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const params = (function () {
  try {
    return new URLSearchParams(location.search);
  } catch (e) {
    return new URLSearchParams("");
  }
})();

const NET = params.get("net") === "1"; // batched log upload, off by default
const MAX_LINES = parseInt(params.get("maxlines") || "400", 10);
// ?quiet=1 hides the console body and leaves the bar. It lives here, not in
// jb.js: jb.js computed a SHOW_LOG flag for it and then never passed it to
// anything, so the documented parameter did nothing.
const QUIET = params.get("quiet") === "1";

const S = {
  started: 0,
  now: 0,
  booted: false,

  stepId: null,
  stepIndex: -1,
  subFrac: 0,
  subNote: "",

  // Per-phase wall clock. `durs[i]` is how long step i held the run, stamped
  // when the run moves off it. The console prints the slowest phases at the
  // end, which is the only honest way to answer "why is this slow" -- the
  // guess is always wrong, because the time is in the WebKit heap race and the
  // kernel aio_multi chain, neither of which is visible in the source.
  //
  // -1 means "no phase in flight", which is distinct from a phase that took
  // 0ms. Those are different facts and the difference matters: a report phase
  // that begins and ends inside the same millisecond is a real measurement of
  // zero, and treating it as "unmeasured" left the final phase with no figure
  // at all about one run in three, depending purely on timer jitter.
  stepStart: -1,
  durs: [],

  pass: 0,
  fail: 0,
  proofs: [],

  lines: [], // { tag, text, level, t }
  domLines: 0,
  dropped: 0,
  emitted: 0, // total lines ever logged, including ones since trimmed

  filter: "all", // all | steps | proofs
  collapsed: QUIET, // ?quiet=1 starts with the console folded away
  autoscroll: true,

  pendingLog: null,
  pendingBar: false,
  pendingVerdicts: false,
  rafId: 0,
  backstopId: 0,
  tickId: 0,

  finished: false,
  finalShown: false,
  frozen: 0,
  ok: false,
  failNote: "",

  netQueue: [],
  netTimer: 0,
};

function now() {
  // S.frozen is stamped the moment the run reports its verdict, so the elapsed
  // time on screen stops counting at the same instant the run stopped. Without
  // it the clock keeps climbing long after the exploit is done and the number
  // on screen stops meaning "how long the run took".
  if (S.frozen) return S.frozen;
  return (S.now = Date.now() - S.started);
}

function clockOf(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return (
    (m < 10 ? "0" : "") + m + ":" + (s % 60 < 10 ? "0" : "") + (s % 60)
  );
}

// ---------------------------------------------------------------------------
// DOM handles (all optional)
// ---------------------------------------------------------------------------
const el = {};

function grab() {
  const ids = [
    "bar", "barFill", "stepNow", "stepNote", "stepList", "statStep",
    "statTime", "statPass", "statFail", "console", "logBody", "logCount",
    "logFilter", "btnAll", "btnSteps", "btnProofs", "btnCopy", "btnClear",
    "btnFold", "title", "subtitle", "verdicts", "final", "boot", "wrap",
    "spin", "msg", "state", "out",
  ];
  for (let i = 0; i < ids.length; i++) el[ids[i]] = $(ids[i]);
  el.body = document.body;
  el.filterEls = [el.btnAll, el.btnSteps, el.btnProofs].filter(Boolean);
}

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

function toggleClass(node, cls, on) {
  if (node) node.classList[on ? "add" : "remove"](cls);
}

// ---------------------------------------------------------------------------
// Progress computation
// ---------------------------------------------------------------------------
function fraction() {
  if (S.stepIndex < 0) return 0;
  const w = STEPS[S.stepIndex].w;
  return Math.min(1, (WEIGHT_BEFORE[S.stepIndex] + w * clamp01(S.subFrac)) / TOTAL_W);
}

function clamp01(v) {
  v = Number(v);
  if (!isFinite(v) || v < 0) return 0;
  return v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------
// Flush -- one pass per frame does every pending DOM write
// ---------------------------------------------------------------------------
// rAF is the fast path: it coalesces a burst of log lines into one DOM write
// per frame. It is also *suspended whenever the page is not visible*, and on a
// console that is a normal thing to happen mid-run (home button, app switch,
// screen off, a background browser tab). A flush that depends on rAF alone then
// never happens at all, which is the "it looks stuck" failure this build exists
// to remove.
//
// So every rAF is paired with a short timer backstop. On a visible page the rAF
// wins and the backstop is cancelled; on a hidden page the backstop does the
// work 100ms later. The backstop only exists while something is pending, so it
// costs nothing once the run is over.
function fire() {
  S.rafId = 0;
  if (S.backstopId) {
    clearTimeout(S.backstopId);
    S.backstopId = 0;
  }
  flush();
}

function schedule() {
  if (S.rafId || S.backstopId) return;
  if (typeof requestAnimationFrame === "function")
    S.rafId = requestAnimationFrame(fire);
  S.backstopId = setTimeout(fire, 100);
}

function flush() {
  if (!S.frozen) S.now = Date.now() - S.started;
  flushBar();
  flushLog();
  flushClock();
  if (S.pendingVerdicts) {
    S.pendingVerdicts = false;
    paintVerdicts();
  }
}

function flushClock() {
  if (!el.statTime) return;
  const t = clockOf(now());
  if (el.statTime.textContent !== t) el.statTime.textContent = t;
  if (el.statStep) {
    const v = S.stepIndex >= 0 ? (S.stepIndex + 1) + "/" + STEPS.length : "0/" + STEPS.length;
    if (el.statStep.textContent !== v) el.statStep.textContent = v;
  }
  // These two are written here rather than in flushLog because they are cheap
  // text writes on a 200ms tick, and because a proof can be logged with the
  // console filtered down to nothing.
  setText(el.statPass, String(S.pass));
  setText(el.statFail, String(S.fail));
}

function flushBar() {
  if (!el.barFill) return;
  const pct = fraction() * 100;
  const s = pct.toFixed(1) + "%";
  if (el.barFill.style.width !== s) el.barFill.style.width = s;
  if (el.bar) el.bar.setAttribute("aria-valuenow", String(Math.round(pct)));
  if (S.pendingBar) {
    S.pendingBar = false;
    paintSteps();
  }
  const lab = S.stepIndex >= 0 ? STEPS[S.stepIndex].label : "starting";
  setText(el.stepNow, lab);
  const note = S.subNote ? lab + "  \u00b7  " + S.subNote : lab;
  setText(el.stepNote, note);
  // The body.done / body.fail classes that recolour the bar are owned by
  // showFinal(), not here -- this function used to set is-done / is-fail,
  // which no stylesheet matches, so the bar only ever turned green or red
  // because showFinal happened to run afterwards.
}

function paintSteps() {
  if (!el.stepList) return;
  const cur = S.stepId;
  let html = "";
  for (let i = 0; i < STEPS.length; i++) {
    const s = STEPS[i];
    const cls =
      s.id === cur ? "on" : i < S.stepIndex ? "done" : i === S.stepIndex ? "on" : "";
    // The ms figure is only worth printing once the phase has actually been
    // measured, otherwise every row ahead of the cursor shows a bare "0ms" and
    // reads as if the whole list is instant.
    const d = S.durs[i];
    const t =
      d === undefined ? "" : '<b class="ms">' + Math.round(d) + "ms</b>";
    html +=
      '<li class="' + cls + '"><i></i><span>' + esc(s.label) + "</span>" + t + "</li>";
  }
  el.stepList.innerHTML = html;
}

function flushLog() {
  if (!el.logBody || !S.pendingLog) return;
  S.pendingLog = false;

  const keep = S.filter;
  const frag = document.createDocumentFragment();
  let appended = 0;

  // Only newly arrived lines are built here. Older lines were already
  // appended, so this stays O(new lines) instead of O(total lines).
  while (S.lines.length > S.domLines) {
    const L = S.lines[S.domLines];
    if (keep !== "all" && !matches(L, keep)) {
      S.domLines++;
      continue;
    }
    const row = document.createElement("div");
    row.className = "l " + L.level;
    const c = document.createElement("span");
    c.className = "c";
    c.textContent = L.t;
    const m = document.createElement("span");
    m.className = "m";
    m.textContent = L.tag;
    const x = document.createElement("span");
    x.className = "x";
    x.textContent = L.text;
    row.appendChild(c);
    row.appendChild(m);
    row.appendChild(x);
    frag.appendChild(row);
    S.domLines++;
    appended++;
  }

  if (appended) {
    el.logBody.appendChild(frag);
    // Cap the DOM: drop from the front, oldest first.
    while (el.logBody.childNodes.length > MAX_LINES) {
      el.logBody.removeChild(el.logBody.firstChild);
      S.dropped++;
    }
    if (S.autoscroll) el.logBody.scrollTop = el.logBody.scrollHeight;
    if (el.logCount) {
      // "N of M", not "N (K older)". The oldest lines go twice -- off the DOM
      // here, and off the model in log() -- so counting only the DOM removals
      // under-reported the loss badly: a 34-line run capped at 10 claimed "2
      // older" when 24 lines were actually gone.
      const shown = el.logBody.childNodes.length;
      const lbl =
        S.emitted > shown ? shown + " of " + S.emitted : String(shown);
      if (el.logCount.textContent !== lbl) el.logCount.textContent = lbl;
    }
  }
}

// Which lines each filter keeps. The two filters are meant to answer different
// questions -- "which proof broke" vs "which phase am I in" -- so they key off
// different things. Keying both off the ok/bad level, as this used to, made
// "steps" a strict superset of "proofs" and made the button pointless.
function matches(L, keep) {
  if (keep === "proofs") return RE_PROOF.test(L.tag);
  if (keep === "steps")
    return RE_STEP.test(L.tag) || L.level === "head" || stepForTag(L.tag) !== null;
  return true;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
// Elapsed milliseconds since the run started. Safe to call before init() --
// jb.js reads it for the summary line, and a module that throws before
// init() still needs to be able to report how long it survived.
export function elapsed() {
  if (!S.started) return 0;
  return Date.now() - S.started;
}

// Measured wall clock per step, in STEPS order, with holes for phases that
// have not closed yet. Exported for the UI self-test, which asserts on the
// numbers rather than trusting that the milliseconds on screen look plausible.
export function durs() {
  return S.durs.slice();
}

// Read through, not a snapshot: useBootSteps() rebinds STEPS, so a caller that
// captured the array at import time would be looking at the boot step table
// after the run steps have taken over.
export function steps() {
  return STEPS;
}

export function init() {
  if (S.booted) return api;
  grab();
  S.started = Date.now();
  S.booted = true;
  if (el.body) el.body.classList.add("has-ui");

  if (el.btnAll) el.btnAll.onclick = () => setFilter("all");
  if (el.btnSteps) el.btnSteps.onclick = () => setFilter("steps");
  if (el.btnProofs) el.btnProofs.onclick = () => setFilter("proofs");
  if (el.btnClear) el.btnClear.onclick = () => {
    S.lines.length = 0;
    S.domLines = 0;
    S.dropped = 0;
    S.emitted = 0;
    if (el.logBody) el.logBody.textContent = "";
    if (el.logCount) el.logCount.textContent = "0";
  };
  if (el.btnFold)
    el.btnFold.onclick = () => {
      S.collapsed = !S.collapsed;
      if (el.body) toggleClass(el.body, "folded", S.collapsed);
      setText(el.btnFold, S.collapsed ? "expand" : "collapse");
    };
  // Apply the starting fold state, so ?quiet=1 and the button always agree.
  if (S.collapsed) {
    if (el.body) toggleClass(el.body, "folded", true);
    setText(el.btnFold, "expand");
  }
  if (el.btnCopy) el.btnCopy.onclick = copyLog;
  if (el.logBody)
    el.logBody.onscroll = function () {
      const b = el.logBody;
      S.autoscroll = b.scrollHeight - b.scrollTop - b.clientHeight < 24;
    };
  if (el.logFilter)
    el.logFilter.onclick = function (e) {
      const b = e.target;
      if (b && b.dataset && b.dataset.f) setFilter(b.dataset.f);
    };

  paintSteps();
  setFilter("all");
  flush();
  if (!S.tickId) {
    // The clock ticker doubles as the fallback flush. requestAnimationFrame is
    // suspended whenever the page is not visible, and on a console the page can
    // lose visibility mid-run (home button, app switch, screen off). Without
    // this the console would freeze and then silently drop the rest of the
    // run's output, which is exactly the "it looks stuck" symptom this build
    // exists to remove.
    //
    // The ticker outlives the verdict on purpose: jb.js logs its proof summary
    // and run verdict *after* the firmware gate may already have called
    // finish(), so those last lines are queued with no ticker and no rAF
    // guaranteed to publish them. It retires itself once the run is over and
    // nothing is pending, so a page left open is not left waking 5x a second
    // forever.
    const t = function () {
      // now() stamps S.now; flushClock() below reads it.
      if (S.pendingBar || S.pendingLog || S.pendingVerdicts) flush();
      else {
        now();
        flushClock();
      }
      if (S.finalShown && !S.pendingLog && !S.pendingBar && !S.pendingVerdicts) {
        S.tickId = 0;
        return;
      }
      S.tickId = setTimeout(t, 200);
    };
    S.tickId = setTimeout(t, 200);
  }
  return api;
}

function setFilter(f) {
  S.filter = f;
  for (let i = 0; i < el.filterEls.length; i++) {
    const b = el.filterEls[i];
    const name = b.id === "btnAll" ? "all" : b.id === "btnSteps" ? "steps" : "proofs";
    toggleClass(b, "on", name === f);
  }
  // Re-render from scratch when the filter changes.
  if (el.logBody) el.logBody.textContent = "";
  S.domLines = 0;
  S.pendingLog = S.lines.length > 0;
  // schedule(), not just the flag: the 200ms ticker retires itself once the run
  // has reported its verdict, and on a finished run a rAF is the only thing
  // left that can repaint. Without this, clicking a filter after the run ended
  // blanked the console and never brought it back.
  schedule();
}

function copyLog() {
  const text = S.lines
    .map(function (L) {
      return "[" + L.t + "] " + L.tag + (L.text ? "  " + L.text : "");
    })
    .join("\n");
  const done = function () {
    setText(el.btnCopy, "copied");
    setTimeout(function () {
      setText(el.btnCopy, "copy");
    }, 1200);
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        legacyCopy(text, done);
      });
      return;
    }
  } catch (e) {}
  legacyCopy(text, done);
}

function legacyCopy(text, done) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    done();
  } catch (e) {
    setText(el.btnCopy, "copy failed");
  }
}

// -- log ---------------------------------------------------------------------
export function log(tag, detail, forceLevel) {
  const t = String(tag == null ? "" : tag);
  const raw = detail == null ? "" : String(detail);
  const level = forceLevel || levelFor(t, raw);
  S.emitted++;
  S.lines.push({ tag: t, text: raw, level: level, t: clockOf(now()) });
  if (S.lines.length > MAX_LINES * 2) {
    // Keep the model bounded too, not just the DOM. domLines is the index of
    // the next unrendered line, so it has to move with the trim or the console
    // would silently stop appending new lines.
    const drop = S.lines.length - MAX_LINES;
    S.lines.splice(0, drop);
    S.domLines = Math.max(0, S.domLines - drop);
  }
  S.pendingLog = true;
  schedule();
  netPush(t, raw);
  if (t === "PROOF-OK") S.pass++;
  else if (t === "PROOF-FAIL") S.fail++;
  if (RE_PROOF.test(t)) {
    S.proofs.push({ ok: t === "PROOF-OK", name: raw, t: now() });
    if (S.proofs.length > 60) S.proofs.shift();
    // The proofs panel is fed by ordinary log lines, not only by verdict():
    // jb.js reports every check() as PROOF-OK/PROOF-FAIL and never calls
    // verdict() directly, so this is the path that actually paints it.
    S.pendingVerdicts = true;
  }
  // Any log line that maps to a known step advances the bar, so a caller that
  // forgets an explicit setStep() still moves the UI forward.
  const st = stepForTag(t);
  if (st && STEP_INDEX[st] > S.stepIndex && !S.finished) setStep(st, "");
  return level;
}

export function setStep(id, note) {
  // Once the run has reported its verdict, a step marker can no longer move
  // the bar. jb.js's finally block runs after the firmware gate may already
  // have called finish(false); without this guard that block would paint
  // fourteen finished steps on a run that never touched the kernel.
  if (S.finished) return;
  const i = STEP_INDEX[id];
  if (i === undefined) return;
  if (i < S.stepIndex) {
    // Never move backwards (a late/duplicate tag must not rewind the bar).
    S.subNote = note || "";
    schedule();
    return;
  }
  // Bank the outgoing phase before adopting the new one. A zero-length span is
  // banked too -- two setStep() calls in the same millisecond is a real
  // measurement, not a missing one.
  if (S.stepIndex >= 0 && S.stepStart >= 0 && S.stepIndex !== i)
    S.durs[S.stepIndex] = now() - S.stepStart;
  S.stepIndex = i;
  S.stepId = id;
  // Restamped on every phase change, not just the first: this is the start of
  // the phase being entered, so the next transition measures the right span.
  S.stepStart = now();
  S.subFrac = 0;
  S.subNote = note || "";
  S.pendingBar = true;
  schedule();
}

// Sub-progress inside the current step, 0..1.
export function sub(fraction, note) {
  const f = clamp01(fraction);
  if (f > S.subFrac || S.stepIndex < 0) S.subFrac = f;
  if (note !== undefined) S.subNote = note || "";
  S.pendingBar = true;
  schedule();
}

export function verdict(name, ok, note) {
  // log() already flags the panel dirty; flush() paints it. Painting here as
  // well would render twice per verdict.
  log(ok ? "PROOF-OK" : "PROOF-FAIL", name + (note ? "  " + note : ""));
}

function paintVerdicts() {
  if (!el.verdicts) return;
  const interesting = S.proofs.filter(function (p) {
    return /jail|jb-|krw|kernel|payload|kpatch|uid|root|chain|syscall|race|thread|wr/i.test(
      p.name,
    );
  });
  if (!interesting.length) {
    el.verdicts.innerHTML = "";
    return;
  }
  let h = "";
  for (let i = 0; i < interesting.length; i++) {
    const p = interesting[i];
    h +=
      '<div class="v ' +
      (p.ok ? "ok" : "bad") +
      '"><span>' +
      (p.ok ? "PASS" : "FAIL") +
      "</span>" +
      esc(p.name.length > 68 ? p.name.slice(0, 68) + "\u2026" : p.name) +
      "</div>";
  }
  el.verdicts.innerHTML = h;
}

export function title(t, sub_) {
  setText(el.title, t);
  setText(el.subtitle, sub_);
}

export function fail(note) {
  if (S.finalShown) {
    // Already reported. Still flush: the caller may have logged the reason on
    // its way here, and a queued rAF must not be the only thing that can
    // publish it.
    flush();
    return;
  }
  S.failNote = note || "";
  log("FATAL", note, "bad");
  finalize(false, note);
}

export function finish(ok, note) {
  if (S.finalShown) {
    // jb.js reaches the firmware gate first (which finishes false) and then
    // runs its finally block, which logs the proof summary and the run verdict
    // AFTER that first finish(). Those lines are in the model but would never
    // reach the DOM, because the queued rAF is the only flush left and it may
    // never run if the page is backgrounded. Flushing here is what makes the
    // summary visible; the banner itself stays as first reported.
    flush();
    return;
  }
  finalize(!!ok, note);
}

// Shared tail for fail() and finish().
function finalize(ok, note) {
  S.finished = true;
  S.ok = !!ok;
  // Bank the phase that was in flight. Nothing else will ever close it, since
  // setStep() is inert from here on, and the last phase is usually the one the
  // user actually wanted the number for (the injection, or the point of
  // failure). Read the clock rather than S.now: S.now is only as fresh as the
  // last flush, which on a hidden page can be 100ms stale.
  const ended = Date.now() - S.started;
  if (S.stepIndex >= 0 && S.stepStart >= 0) S.durs[S.stepIndex] = ended - S.stepStart;
  // Freeze the clock, so the elapsed time on screen stops at the instant the
  // run stopped. The ticker is left running until it has drained the last
  // queued log lines, then retires itself.
  S.now = ended;
  S.frozen = S.now;
  // Land the bar at 100% on success, leave it where it stopped on failure so
  // the bar always shows how far it actually got.
  if (ok) {
    S.stepIndex = STEPS.length - 1;
    S.stepId = STEPS[STEPS.length - 1].id;
    S.subFrac = 1;
    S.subNote = note || "";
  } else if (note) {
    S.failNote = note;
  }
  S.pendingBar = true;
  logSlowest();
  flush();
  if (!S.finalShown) {
    S.finalShown = true;
    showFinal(ok, note);
  }
}

// The phase breakdown, printed once at the end of the run. This exists because
// "it is slow" is not actionable and the source does not show where the time
// goes: the WebKit heap race and the kernel aio_multi chain are both timed by
// the target, not by this code. Measuring the phases and showing the ranking is
// the difference between a guess and a fact.
function logSlowest() {
  const rows = [];
  let total = 0;
  for (let i = 0; i < STEPS.length; i++) {
    const d = S.durs[i];
    if (d === undefined) continue;
    rows.push({ label: STEPS[i].label, ms: d });
    total += d;
  }
  if (!rows.length) return;
  rows.sort(function (a, b) {
    return b.ms - a.ms;
  });
  const top = rows.slice(0, 4);
  let s = "";
  for (let i = 0; i < top.length; i++) {
    if (i) s += "  ";
    s += top[i].label + " " + Math.round(top[i].ms) + "ms";
  }
  log(
    "PHASE-TIME",
    "measured " + rows.length + " phases, " + Math.round(total) + "ms total" +
      " | slowest: " + s,
    "head",
  );
}

function showFinal(ok, note) {
  if (el.final) {
    el.final.className = "final " + (ok ? "ok" : "bad");
    el.final.style.display = "block";
    let h = ok
      ? "<b>JAILBROKEN</b>"
      : "<b>NOT COMPLETED</b>";
    h +=
      '<div class="fs">passed ' +
      S.pass +
      " &middot; failed " +
      S.fail +
      " &middot; " +
      clockOf(now()) +
      "</div>";
    if (note) h += '<div class="fn">' + esc(note) + "</div>";
    if (ok)
      h +=
        '<div class="fw">Kernel <code>.text</code> and <code>.data</code> are ' +
        "patched in place. Power the console off and back on to clear them " +
        "before closing the browser.</div>";
    el.final.innerHTML = h;
  }
  if (el.body) {
    toggleClass(el.body, "done", ok);
    toggleClass(el.body, "fail", !ok);
  }
  setText(el.spin, "");
  if (el.spin) el.spin.style.display = "none";
}

// ---------------------------------------------------------------------------
// Batched network logging (?net=1)
// ---------------------------------------------------------------------------
function netPush(tag, detail) {
  if (!NET) return;
  S.netQueue.push("PS4-JB&e=" + encodeURIComponent(tag) + "&d=" + encodeURIComponent(detail));
  if (S.netTimer) return;
  S.netTimer = setTimeout(function () {
    S.netTimer = 0;
    const body = S.netQueue.join("&");
    S.netQueue.length = 0;
    try {
      const x = new XMLHttpRequest();
      x.open("POST", "/t", true);
      x.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
      x.send(body);
    } catch (e) {}
  }, 500);
}

// ---------------------------------------------------------------------------
// Test/replay surface -- lets the UI be exercised without a console
// ---------------------------------------------------------------------------
const api = {
  init,
  log,
  setStep,
  sub,
  verdict,
  fail,
  finish,
  title,
  useBootSteps,
  elapsed,
  levelFor,
  stepForTag,
  fraction,
  durs,
  state: S,
  // Live: useBootSteps() rebinds STEPS, so read through rather than snapshot.
  get steps() {
    return STEPS;
  },
};
export default api;
