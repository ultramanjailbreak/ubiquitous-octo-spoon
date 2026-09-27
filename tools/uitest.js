// uitest.js -- replay a recorded run through ui.js without a PS4.
//
// The exploit itself can only run on a real 13.52 console, which makes the
// loader chrome impossible to review on a desktop. This replays the same tag
// and step sequence a real run emits, so the bar, the step list, the console
// filters, the verdicts panel and the final banner can all be checked in any
// browser. Nothing here touches memory or the network.
//
//   tools/uitest.html            full successful run, animated
//   tools/uitest.html?case=fail  stopped mid-primitive
//   tools/uitest.html?case=gate  rejected by the firmware gate
//   tools/uitest.html?slow=1     one line per 120ms, to watch it advance

// Dynamic import with a cache-busting query, so editing ui.js and reloading
// this page actually picks up the new ui.js. A static `import "../ui.js"` is
// served straight from the browser's module cache, which makes a UI change look
// like it did nothing -- the same trap as a stale appcache hash.
const mod = await import("../ui.js?dev=" + (new URLSearchParams(location.search).get("v") || "1"));
// The default export is the whole surface in one object, which is also the only
// way to reach `state` -- the step index is what tells this replay which phases
// it actually entered, and `state` is not a named export.
const ui = mod.default;

ui.init();

const params = new URLSearchParams(location.search);
const which = params.get("case") || "ok";
const ASSERT = params.get("assert") === "1";
const SLOW = params.get("slow") === "1";
// The timing assertions compare measured spans against the hold, so the
// replay has to actually hold. ?slow=1 uses 120ms (4s for a full run);
// ?assert=1 only needs enough to survive millisecond timer granularity, so it
// gets 25ms by default and can be overridden with ?gap=N.
const GAP = params.get("gap")
  ? parseInt(params.get("gap"), 10)
  : SLOW
    ? 120
    : ASSERT
      ? 25
      : 0;

ui.title("RAW GAME", "13.52 · 13.52 (self-test)");

// [tag, detail] -- real tags from jb.js, so levelFor()/stepForTag() are
// exercised on exactly the strings the run produces.
const RUN_OK = [
  ["BUILD", "raw13g-13.52 single-fw build"],
  ["FW", "13.52"],
  ["GATE", "fw=13.52 -- the only supported firmware, table present"],
  ["WARM", "jb.js module graph prefetched"],
  ["WARM", "goldhen.bin 286kB"],
  ["WARM", "patches/1352.bin 632B"],
  ["PHASE", "arbitrary read/write primitive"],
  ["ADDROF", "carrier window @ 0x100 alignment"],
  ["GROOM", "1 of 1 candidate usable"],
  ["RETRY", "attempt 2/6"],
  ["PRIMITIVE-OK", "window 0x7f2a3c000 stable"],
  ["BASES", "libkernel @ 0xffffff800032b000"],
  ["BASES", "webkit @ 0xffffff8000480000"],
  ["STUBS", "gadget chain built (5 stubs)"],
  ["SYSCALL", "syscall table resolved at +0x2c0"],
  ["CH-N", "worker 0 ready"],
  ["CH-N", "worker 1 ready"],
  ["PR-POOL", "race pool armed, 8 slots"],
  ["PR-POOL", "claimed 3 slots"],
  ["KRW", "kernel read/write test at kbase+0x1e0"],
  ["PROOF-OK", "kernel .data magic matched"],
  ["PROOF-FAIL", "junk pool -- discarded (expected on 1 of 3 attempts)"],
  ["JB-PROBE", "uid 1000 -> 0 via setuid gadget"],
  ["PROOF-OK", "jailbreak: getuid() == 0"],
  ["KPATCH", "kpatch 1352.bin (632B) staged"],
  ["KPATCH", "2 sysent sites written"],
  ["PROOF-OK", "kernel .text patched"],
  ["PAYLOAD", "goldhen.bin 286kB staged"],
  ["PAYLOAD", "written in 1120 windows of 0x100"],
  ["PROOF-OK", "payload thread running"],
  ["CAPS", "kern.file registered"],
  ["THREW", "nothing"],
  ["PROOF-SUMMARY-FINAL", "pass=3 fail=1"],
  ["RUN-VERDICT", "SUCCESS jailbroken=1 kpatched=1 payload_running=1 proofs=3/4 elapsed=41.2s"],
];

const RUN_FAIL = [
  ["BUILD", "raw13g-13.52 single-fw build"],
  ["FW", "13.52"],
  ["GATE", "fw=13.52 -- the only supported firmware, table present"],
  ["WARM", "jb.js module graph prefetched"],
  ["PHASE", "arbitrary read/write primitive"],
  ["ADDROF", "carrier window @ 0x100 alignment"],
  ["GROOM", "1 of 1 candidate usable"],
  ["PRIMITIVE-OK", "window 0x7f2a3c000 stable"],
  ["BASES", "libkernel @ 0xffffff800032b000"],
  ["STUBS", "gadget chain built (5 stubs)"],
  ["GIVEUP", "no usable race slot in 6 attempts"],
  ["PROOF-FAIL", "race pool exhausted after 6 attempts"],
  ["THREW", "no primitive"],
  ["PROOF-SUMMARY-FINAL", "pass=0 fail=1  INCOMPLETE"],
  ["RUN-VERDICT", "FAILED jailbroken=0 kpatched=0 payload_running=0 proofs=0/1 elapsed=12.4s"],
];

const RUN_GATE = [
  ["BUILD", "raw13g-13.52 single-fw build"],
  ["FW", "13.50"],
  [
    "GATE-FAIL",
    "13.50 is not 13.52 -- this build has one offset table only, and there is no override",
  ],
  ["HINT", "this build is for 13.52 only; the upstream multi-fw build is needed for any other firmware"],
  ["PROOF-SUMMARY-FINAL", "pass=0 fail=0  INCOMPLETE  (no run: stopped at the firmware gate)"],
  ["RUN-VERDICT", "FAILED jailbroken=0 kpatched=0 payload_running=0 proofs=0/0 elapsed=0.1s"],
];

// `ran` mirrors jb.js's gatePassed flag: false means the firmware gate
// rejected the run, in which case jb.js never walks the bar forward through
// teardown/report. `throwAt` mirrors the catch block calling ui.fail() before
// the finally block, which is what stops the bar at the break point.
const CASES = {
  ok: { lines: RUN_OK, ran: true, verdict: [true, ""] },
  fail: {
    lines: RUN_FAIL,
    ran: true,
    throwAt: "PROOF-FAIL",
    throwNote: "threw: no usable primitive",
    verdict: [false, "no usable primitive -- reboot required"],
  },
  gate: {
    lines: RUN_GATE,
    ran: false,
    verdict: [false, "13.50 is not 13.52 -- this build has one table only"],
  },
};

const c = CASES[which] || CASES.ok;
const q = new URLSearchParams(location.search);

// ?stop=<tag> holds the bar mid-run, for inspecting the in-progress layout.
const stopAt = q.get("stop");

// Every step index the replay actually entered, in order. The timing
// assertions need this because "the last phase is closed" cannot be checked
// against the step table: a run that stops early never reaches the last row,
// and demanding a duration for a step that was never entered would be a test
// that fails on correct code.
const entered = [];
function noteStep() {
  const i = ui.state.stepIndex;
  if (i >= 0 && entered[entered.length - 1] !== i) entered.push(i);
}

async function main() {
  for (let i = 0; i < c.lines.length; i++) {
    const pair = c.lines[i];
    if (stopAt && pair[0] === stopAt) {
      ui.sub(0.5, "held at " + pair[0]);
      noteStep();
      return;
    }
    // The gate verdict is rendered as soon as it is reached, and everything
    // after it lands via the next flush -- same ordering as jb.js.
    if (pair[0] === "PROOF-SUMMARY-FINAL" && !c.ran) {
      ui.finish(c.verdict[0], c.verdict[1]);
    }
    ui.log(pair[0], pair[1]);
    noteStep();
    if (c.throwAt && pair[0] === c.throwAt) ui.fail(c.throwNote);
    if (GAP)
      await new Promise(function (r) {
        setTimeout(r, GAP);
      });
  }
  if (stopAt) {
    ui.sub(0.5, "held before " + stopAt);
    return;
  }
  if (!c.ran) {
    noteStep();
    return;
  } // already finished by the gate
  ui.setStep("report");
  noteStep();
  ui.finish(c.verdict[0], c.verdict[1]);
}

// ?assert=1 checks the per-phase timing instead of just displaying it.
//
// The durations are easy to get subtly wrong in ways that still look right on
// screen: never stamped at all, stamped on entry rather than on exit (so every
// phase reads 0ms except the one in flight), or the last phase left unclosed
// because nothing comes after it to close it. So the assertions here are about
// the numbers, not the pixels: real gaps must show up as real milliseconds, and
// the final phase must be measured even though no step follows it.
async function assertTiming() {
  const out = [];
  let bad = 0;
  function check(name, ok, detail) {
    if (!ok) bad++;
    out.push((ok ? "PASS  " : "FAIL  ") + name + (detail ? "  " + detail : ""));
  }

  const durs = ui.durs();
  // `steps` is a getter on the api object, so this reads the live table. Safe
  // to capture here: assertTiming() only runs once the replay is over, by which
  // point useBootSteps() has long since rebound STEPS to the run steps.
  const steps = ui.steps;
  const measured = [];
  for (let i = 0; i < steps.length; i++)
    if (durs[i] !== undefined) measured.push({ label: steps[i].label, ms: durs[i], i: i });

  check("at least one phase measured", measured.length > 0, "n=" + measured.length);

  // The replay holds each step for GAP ms, so a correct measurement is at least
  // roughly GAP. A phase that reads ~0 while the clock moved means the span is
  // being stamped at the wrong end.
  const big = measured.filter(function (m) {
    return m.ms >= GAP * 0.5;
  });
  check(
    "held phases measure >= half the hold",
    big.length > 0,
    "gap=" + GAP + "ms big=" + big.length,
  );

  // The last phase the replay entered has no successor, so only finalize() can
  // close it. This is checked against the phases actually entered, NOT against
  // the end of the step table: a replay that stops early never reaches the last
  // row, and demanding a duration for a step that was never entered would be a
  // test that fails on correct code.
  const unclosed = entered.filter(function (i) {
    return durs[i] === undefined;
  });
  check(
    "every entered phase is closed, including the last",
    unclosed.length === 0,
    unclosed.length
      ? "unclosed=" + unclosed.map(function (i) { return steps[i].label; }).join(",")
      : "closed " + entered.length + " of " + entered.length,
  );

  // ...and nothing beyond them was measured either, which would mean a span was
  // attributed to a phase the run never reached.
  const stray = measured.filter(function (m) {
    return entered.indexOf(m.i) === -1;
  });
  check(
    "no phase measured that the run never entered",
    stray.length === 0,
    stray.length ? stray.map(function (m) { return m.label; }).join(",") : "",
  );

  // Phases are contiguous, so the measured spans must not sum to more than the
  // whole run. Overlap would mean a span was left open across a transition.
  const sum = measured.reduce(function (a, m) {
    return a + m.ms;
  }, 0);
  const total = ui.elapsed();
  check(
    "phase spans do not overlap",
    sum <= total + GAP * 2,
    "sum=" + Math.round(sum) + "ms elapsed=" + Math.round(total) + "ms",
  );

  const body = document.getElementById("logBody");
  const hasPhase = /PHASE-TIME/.test(body ? body.textContent : "");
  check("PHASE-TIME summary reached the DOM", hasPhase);

  const cell = document.querySelector("#stepList li b.ms");
  check("step list renders a duration", !!cell, cell ? cell.textContent : "no b.ms");

  out.push(
    bad === 0
      ? "\nALL PASS  (" + measured.length + " phases measured, " + entered.length + " entered)"
      : "\n" + bad + " FAILURE(S)",
  );
  const pre = document.getElementById("assert");
  if (pre) {
    pre.textContent = out.join("\n");
    pre.className = bad === 0 ? "pass" : "fail";
  }
  window.__uitest = { bad: bad, out: out, durs: durs, measured: measured };
}

main().then(function () {
  if (!ASSERT) return;
  // Let the last flush land before reading the DOM back.
  return new Promise(function (r) {
    setTimeout(r, 150);
  }).then(assertTiming);
});
