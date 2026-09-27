// check.js -- static self-checks for the 13.52 build.
//
// Everything here is checkable without a console, and everything here is
// something that would otherwise only be discovered on a PS4: a typo in an
// offset name, a patch blob that did not get copied, an appcache manifest that
// omits a file the run fetches. Run tools/check.html.

// Cache-busted for the same reason as uitest.js: these checks exist to catch
// a broken ps4_offsets.js, so they must never run against a cached copy of it.
const {
  PS4,
  REQUIRED_KEYS,
  OPTIONAL_KEYS,
  SUPPORTED_FW,
  parseUa,
  offsetsFor,
} = await import("../ps4_offsets.js?v=" + (new URLSearchParams(location.search).get("v") || "1"));

const rows = [];
let failed = 0;

function ok(name, pass, detail) {
  if (!pass) failed++;
  rows.push({
    name: String(name).replace(/^\.\.\//, ""),
    pass: !!pass,
    detail: detail == null ? "" : String(detail),
  });
}

function group(name) {
  rows.push({ group: name });
}

// ---------------------------------------------------------------------------
group("offset table");
// ---------------------------------------------------------------------------
const off = PS4[SUPPORTED_FW];
ok("table has the supported key", !!off, SUPPORTED_FW);
ok("table has exactly one firmware", Object.keys(PS4).length === 1, Object.keys(PS4).join(","));

let missingReq = [];
for (const k of REQUIRED_KEYS) if (!(k in off)) missingReq.push(k);
ok("every REQUIRED_KEY is present", missingReq.length === 0, missingReq.join(" ") || REQUIRED_KEYS.length + " keys");

let missingOpt = [];
for (const k of OPTIONAL_KEYS) if (!(k in off)) missingOpt.push(k);
ok("every OPTIONAL_KEY is present", missingOpt.length === 0, missingOpt.join(" ") || OPTIONAL_KEYS.length + " keys");

// A hex value that lost its 0x prefix is the classic way an offset table goes
// quietly wrong -- it still parses as a number, just the wrong one.
let notHex = [];
for (const k of REQUIRED_KEYS.concat(OPTIONAL_KEYS)) {
  const v = off[k];
  if (typeof v === "number" && !isFinite(v)) notHex.push(k);
}
ok("all scalar offsets are finite numbers", notHex.length === 0, notHex.join(" ") || "ok");

let stubCount = Object.keys(off.k_stubs || {}).length;
ok("syscall stub table is populated", stubCount > 30, stubCount + " stubs");

ok("kpatch blob is 13.52", off.kpatch === "1352.bin", off.kpatch);
ok("payload blob is goldhen", off.payload === "goldhen.bin", off.payload);

// ---------------------------------------------------------------------------
group("user agent gate");
// ---------------------------------------------------------------------------
const UAs = [
  ["Mozilla/5.0 (PlayStation 4/13.52) AppleWebKit/537.73 (KHTML, like Gecko)", true, "13.52"],
  ["Mozilla/5.0 (PlayStation 4/13.5) AppleWebKit/537.73 (KHTML, like Gecko)", false, null],
  ["Mozilla/5.0 (PlayStation 4 8.00) AppleWebKit/537.73 (KHTML, like Gecko)", false, null],
  ["Mozilla/5.0 (PlayStation 4/12.02) AppleWebKit/605.1.15 (KHTML, like Gecko)", false, null],
  ["Mozilla/5.0 (PlayStation 4/9.00) AppleWebKit/601.1.46 (KHTML, like Gecko)", false, null],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", false, null],
  ["", false, null],
];
for (const [ua, wantOff, wantKey] of UAs) {
  const r = parseUa(ua);
  const label = ua.slice(0, 46) || "(empty)";
  ok("gate " + label, (r.off !== null) === wantOff && (!wantKey || r.key === wantKey), "key=" + r.key);
}
ok("offsetsFor still works", (function () {
  const r = offsetsFor(UAs[0][0]);
  return r.key === "13.52" && r.off === off;
})(), "delegates to parseUa");

// ---------------------------------------------------------------------------
group("shipped assets");
// ---------------------------------------------------------------------------
// Paths are relative to this page, which lives in tools/.
const ASSETS = [
  ["../index.html", null],
  ["../boot.js", null],
  ["../jb.html", null],
  ["../jb.js", null],
  ["../ui.js", null],
  ["../ui.css", null],
  ["../mem.js", null],
  ["../int64.js", null],
  ["../core.js", null],
  ["../rpc_worker.js", null],
  ["../ps4_offsets.js", null],
  ["../logo_raw.png", null],
  ["../cache.appcache", null],
  ["../goldhen.bin", 293120],
  ["../patches/1352.bin", 632],
];

const sizes = {};
await Promise.all(
  ASSETS.map(async function (a) {
    try {
      const r = await fetch(a[0], { cache: "no-store" });
      if (!r.ok) {
        ok("asset " + a[0], false, "HTTP " + r.status);
        return;
      }
      const b = await r.arrayBuffer();
      sizes[a[0]] = b.byteLength;
      ok("asset " + a[0], a[1] === null || b.byteLength === a[1], b.byteLength + " bytes");
    } catch (e) {
      ok("asset " + a[0], false, String(e));
    }
  }),
);

// boot.js prefetches its whole graph before handing off to jb.html, and jb.js
// re-fetches whatever is not ready. A typo in any of those paths fails silently
// on the console -- a 404 inside a .catch() that swallows -- and only makes the
// run slower, so they are fetched here instead.
const WARM = [
  "jb.js",
  "core.js",
  "mem.js",
  "int64.js",
  "ui.css",
  "rpc_worker.js",
  "goldhen.bin",
  "patches/1352.bin",
];
for (const w of WARM) {
  try {
    const r = await fetch("../" + w, { cache: "no-store" });
    const b = r.ok ? await r.arrayBuffer() : null;
    ok("warm target " + w, !!b && b.byteLength > 0, b ? b.byteLength + " bytes" : "HTTP " + r.status);
  } catch (e) {
    ok("warm target " + w, false, String(e));
  }
}

// The hand-off target has to exist, or the landing page navigates into a 404.
try {
  const r = await fetch("../jb.html", { cache: "no-store" });
  ok("hand-off target jb.html", r.ok, "HTTP " + r.status);
} catch (e) {
  ok("hand-off target jb.html", false, String(e));
}

// The warm list is hand-maintained, and the failure mode for getting it wrong
// is invisible: an unwarmed module is simply fetched on the critical path
// instead, and the run is a bit slower with nothing logged anywhere. So derive
// the requirement instead -- every static import of jb.js has to be either
// warmed or already loaded by boot.js, which imports ps4_offsets.js and ui.js
// itself. This is the check that stops the list rotting the next time somebody
// adds an import to jb.js and forgets this file.
let jbSrc = "";
let bootSrc = "";
try {
  jbSrc = stripComments(await (await fetch("../jb.js", { cache: "no-store" })).text());
  bootSrc = await (await fetch("../boot.js", { cache: "no-store" })).text();
} catch (e) {
  ok("read module graph", false, String(e));
}
const imported = [];
for (const m of jbSrc.matchAll(/^import[^;]*?from\s*"\.\/([^"]+)"/gm)) imported.push(m[1]);
const bootImports = new Set();
for (const m of bootSrc.matchAll(/^import[^;]*?from\s*"\.\/([^"]+)"/gm)) bootImports.add(m[1]);
const coldImports = imported.filter(function (f) {
  return !bootImports.has(f) && WARM.indexOf(f) === -1;
});
ok(
  "every jb.js import is warmed or already loaded",
  imported.length > 0 && coldImports.length === 0,
  coldImports.length
    ? "cold on the critical path: " + coldImports.join(",")
    : imported.length + " imports, all covered",
);

// The patch table and the kpatch blob must agree, or the run writes one
// firmware's patch set onto another.
ok("kpatch blob matches the table", off.kpatch === "1352.bin" && !!sizes["../patches/1352.bin"], off.kpatch);

// ---------------------------------------------------------------------------
group("appcache manifest");
// ---------------------------------------------------------------------------
try {
  const r = await fetch("../cache.appcache", { cache: "no-store" });
  const text = await r.text();

  // A UTF-8 BOM in front of "CACHE MANIFEST" makes appcache reject the whole
  // manifest as malformed. The console then just runs online with no visible
  // reason why, and PowerShell's Set-Content -Encoding UTF8 adds exactly that
  // BOM on 5.1 -- so it gets checked explicitly.
  ok(
    "manifest has no BOM",
    text.charCodeAt(0) !== 0xfeff,
    "first bytes: " + JSON.stringify(text.slice(0, 14)),
  );
  const body = text.replace(/^\ufeff/, "");
  const firstLine = body.split("\n")[0].trim();
  ok("manifest header is exact", firstLine === "CACHE MANIFEST", JSON.stringify(firstLine));

  // Walk the sections properly. Only the implicit CACHE section holds entries;
  // NETWORK: and FALLBACK: have bodies that are not URLs-with-hashes, so
  // grabbing "every line that is not a comment" counts "index.html index.html"
  // as a cache entry and then fails the sha256 test on it.
  const entries = [];
  let section = "cache";
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#/i.test(line)) continue;
    if (/^NETWORK:/i.test(line)) {
      section = "network";
      continue;
    }
    if (/^FALLBACK:/i.test(line)) {
      section = "fallback";
      continue;
    }
    if (/^CACHE:?$/i.test(line)) {
      section = "cache";
      continue;
    }
    if (section !== "cache") continue;
    const m = /^(\S+)(?:\s+#([0-9a-fA-F]{64}))?$/.exec(line);
    if (m) entries.push({ file: m[1], hash: m[2] || null, line: line });
  }
  const listed = entries.map(function (e) {
    return e.file;
  });

  const mustList = [
    "index.html", "boot.js", "jb.html", "jb.js", "ui.js", "ui.css",
    "mem.js", "int64.js", "ps4_offsets.js", "rpc_worker.js",
    "goldhen.bin", "patches/1352.bin", "logo_raw.png",
  ];
  let notListed = [];
  for (const f of mustList) if (listed.indexOf(f) < 0) notListed.push(f);
  ok("manifest lists every runtime file", notListed.length === 0, notListed.join(" ") || mustList.length + " entries");

  // Files that must NOT be cached: other firmware's patch blobs and the
  // duplicate payload would waste the console's storage quota and delay the
  // first run for no benefit. The ?v= aliases are stale for a different reason:
  // jb.js and mem.js now import plain "./core.js", so a query-string copy would
  // be a second module instance of the same file with its own state.
  const stale = listed.filter(function (f) {
    return /payload2\.bin|13\.0[24]|13\.50|1350|core\.js\?v=|jb\.js\?v=/.test(f);
  });
  ok("manifest has no stale entries", stale.length === 0, stale.join(" ") || "clean");

  // Every manifest hash must match the file on disk. A stale hash does not fail
  // loudly: appcache keeps serving the old copy from the console's cache and
  // the edited code never runs, which reads as "my change did nothing".
  // Regenerate with tools/hash.ps1.
  const noHash = entries
    .filter(function (e) {
      return !e.hash;
    })
    .map(function (e) {
      return e.file;
    });
  ok("every entry has a sha256", noHash.length === 0, noHash.join(" ") || entries.length + " hashed");

  const mismatched = [];
  for (const e of entries) {
    if (!e) continue;
    try {
      const buf = await crypto.subtle.digest("SHA-256", await (await fetch("../" + e.file, { cache: "no-store" })).arrayBuffer());
      const hex = Array.prototype.map
        .call(new Uint8Array(buf), function (b) {
          return ("0" + b.toString(16)).slice(-2);
        })
        .join("");
      if (hex !== e.hash) mismatched.push(e.file);
    } catch (err) {
      mismatched.push(e.file + " (unreadable)");
    }
  }
  ok("manifest hashes match the files", mismatched.length === 0, mismatched.join(" ") || "all current -- run tools/hash.ps1 if not");
} catch (e) {
  ok("appcache manifest", false, String(e));
}

// ---------------------------------------------------------------------------
group("no other firmware referenced");
// ---------------------------------------------------------------------------
// Strip comments before grepping. The sources discuss the other firmwares at
// length -- boot.js explains that the old page listed them, ps4_offsets.js
// documents what each UA minor means -- and flagging that prose is noise. What
// matters is that no *code* can still reach another firmware's table or patch
// blob, so that is what gets tested.
//
// Paths are relative to this page, which lives in tools/.
const SRC = ["../jb.js", "../boot.js", "../ui.js", "../ps4_offsets.js", "../mem.js", "../index.html", "../jb.html"];

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    // Trailing comments, but not a "//" inside a string or a URL.
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1 ");
}

// Things that would mean a second firmware is still reachable.
const RISKS = [
  [/patches\/(?!1352\b)\d+\.bin/, "reference to another firmware's patch blob"],
  [/\bpayload2\.bin\b/, "reference to the duplicate payload"],
  [/PS4\[["'`]((?!13\.52)[\d.]+)/, "PS4 table lookup with a non-13.52 key"],
  [/"(?!13\.52"|13\.5[02]")[\d]{2}\.[\d]{2}"\s*:\s*\{/, "second firmware key in a table"],
  [/\?force=|\bforceUA\b/, "firmware override escape hatch"],
];

await Promise.all(
  SRC.map(async function (f) {
    try {
      const code = stripComments(await (await fetch(f, { cache: "no-store" })).text());
      const hits = [];
      code.split("\n").forEach(function (line, i) {
        for (const [re, why] of RISKS) {
          const m = re.exec(line);
          if (m) hits.push((i + 1) + ": " + why + " -> " + line.trim().slice(0, 70));
        }
      });
      ok("no other firmware reachable from " + f, hits.length === 0, hits.join(" | ") || "clean");
    } catch (e) {
      ok("no other firmware reachable from " + f, false, String(e));
    }
  }),
);

// ---------------------------------------------------------------------------
group("latency and phase timing");
// ---------------------------------------------------------------------------
// These check the *shape* of two things that are easy to regress silently.
//
// 1. The per-phase timing. The step list and the PHASE-TIME summary are only
//    worth anything if the spans are stamped on exit rather than on entry, and
//    if the final phase is closed at all -- the last phase has no successor, so
//    only finalize() can close it, and a run whose last phase always reads 0ms
//    still looks perfectly plausible on screen. tools/uitest.html?assert=1
//    proves the numbers behave; these checks prove the surface still exists,
//    because a renamed export fails just as silently as a broken one.
// 2. The two concurrency changes. Reverting either is a one-line edit that
//    costs ~300ms per run and produces no error at all, so it is worth a
//    static tripwire.
const TIMING_SRC = ["../ui.js", "../ui.css", "../jb.js"];
const timingText = {};
for (const f of TIMING_SRC) {
  try {
    timingText[f] = stripComments(await (await fetch(f, { cache: "no-store" })).text());
  } catch (e) {
    timingText[f] = "";
    ok("read " + f, false, String(e));
  }
}

const uiCode = timingText["../ui.js"] || "";
ok("ui.js exports the timing surface", /export function durs\(\)/.test(uiCode) && /export function steps\(\)/.test(uiCode), "durs() steps()");

// These two deliberately match on the *contract* -- "a span is banked, keyed by
// the step in flight" -- and not on the right-hand side. An earlier version of
// these checks pinned the exact expression, and a harmless refactor of that
// expression turned both red, which is how a tripwire stops being trusted.
const setStepBody = /export function setStep\([\s\S]*?\n\}/.exec(uiCode);
const finalizeBody = /function finalize\([\s\S]*?\n\}/.exec(uiCode);
ok(
  "ui.js banks a span when the phase changes",
  !!setStepBody && /S\.durs\[S\.stepIndex\]\s*=/.test(setStepBody[0]),
  "setStep",
);
ok(
  "ui.js closes the final phase in finalize",
  !!finalizeBody && /S\.durs\[S\.stepIndex\]\s*=/.test(finalizeBody[0]),
  "finalize",
);

// The actual bug these two sites had: the span was banked only `if (spent > 0)`.
// A report phase that starts and finishes inside the same millisecond is a real
// measurement of zero, so the guard silently dropped it -- and because the last
// phase has no successor to close it, the run simply showed no figure for it
// about one time in three, depending on timer jitter. Nothing looked broken.
// The sentinel is what distinguishes "no phase in flight" from "0ms phase".
ok(
  "a zero-length phase is not discarded",
  /stepStart:\s*-1/.test(uiCode) &&
    !!setStepBody &&
    /S\.stepStart\s*>=\s*0/.test(setStepBody[0]) &&
    !!finalizeBody &&
    /S\.stepStart\s*>=\s*0/.test(finalizeBody[0]) &&
    !/if\s*\(\s*spent\s*>\s*0\s*\)/.test(uiCode),
  "-1 sentinel, no 'spent > 0' drop",
);
ok("ui.js emits the phase ranking", /PHASE-TIME/.test(uiCode), "logSlowest");
ok("ui.css styles the duration cell", /#stepList li b\.ms/.test(timingText["../ui.css"] || ""), "b.ms");

const jbCode = timingText["../jb.js"] || "";
// Sequential bring-up is the regression: `const w1 = await bringWorker(..)`
// followed by `const w2 = await bringWorker(..)`. Both handshakes have to
// complete in series that way.
ok(
  "both workers are brought up concurrently",
  !/await\s+bringWorker\(\s*"w1"\s*\)[\s\S]{0,80}?await\s+bringWorker\(\s*"w2"/.test(jbCode) &&
    /bringWorker\("w1"\)/.test(jbCode) &&
    /bringWorker\("w2"\)/.test(jbCode),
  "no serialised handshake",
);
ok("the two getpid probes are issued together", /Promise\.all\(\s*\[\s*w1\.fire/.test(jbCode), "parallel fire");
// The park wait used to be a bare `setTimeout(r, 250)`. A FIFO ping barrier in
// front of the spin turns "posted it and hoped" into a fact, and is what makes
// the short grace afterwards safe.
ok(
  "the park wait is a FIFO barrier, not a blind sleep",
  /postMessage\(\{\s*id:\s*-1,\s*name:\s*"spin"/.test(jbCode) &&
    /rpc\("ping",\s*\d+\)/.test(jbCode) &&
    !/setTimeout\(r,\s*250\)/.test(jbCode),
  "barrier + short grace",
);

// ---------------------------------------------------------------------------
group("single-page hand-off");
// ---------------------------------------------------------------------------
// The landing page runs the exploit in its own document rather than navigating
// to jb.html. That removes a full teardown -- re-fetch, re-parse, rebuild every
// node, re-init -- and it is why the boot-phase log lines now survive into the
// run. It also removes the navigation's side effect of killing three in-flight
// warm fetches, so all eight now complete.
//
// It rests on four assumptions. None of them fail loudly: a double init
// double-binds every button handler, a missing export throws an import error
// that the fallback silently swallows, and a reordered step table just shows
// the wrong phase name for a frame. So each one gets a tripwire.
const SPOOL = ["../boot.js", "../ui.js", "../jb.html"];
const spool = {};
for (const f of SPOOL) {
  try {
    spool[f] = await (await fetch(f, { cache: "no-store" })).text();
  } catch (e) {
    spool[f] = "";
    ok("read " + f, false, String(e));
  }
}
const bootPage = spool["../boot.js"] || "";
const uiRaw = spool["../ui.js"] || "";
const jbHtmlSrc = spool["../jb.html"] || "";
const uiBare = stripComments(uiRaw);

// (1) init() must be idempotent. jb.js calls it at its top level and boot.js
// has already called it; without the guard every onclick is bound twice, so the
// first click fires two handlers.
const initBody = /export function init\(\)\s*\{([\s\S]*)/.exec(uiBare);
ok(
  "ui.init() is idempotent, so jb.js's second call is a no-op",
  !!initBody && /if\s*\(\s*S\.booted\s*\)\s*return\s+api\s*;/.test(initBody[1]),
  "S.booted guard",
);

// (2) The switch back to the full step table has to exist, or boot.js's import
// throws and the run silently degrades to the old two-page navigation.
ok(
  "ui.js exports useRunSteps()",
  /export function useRunSteps\(\)/.test(uiBare) &&
    /reweight\(FULL_STEPS\)/.test(uiBare),
  "reweight(FULL_STEPS)",
);

// (3) The load-bearing one. reweight() carries the bar's position across a
// table change by matching the current step's id, and the landing page switches
// tables mid-bar. That is only correct if BOOT_STEPS is a prefix of FULL_STEPS;
// if a boot step were renamed or reordered, the bar would carry over to nothing
// and sit on an unrelated phase until the run's first step() call moved it.
const tableIds = function (name) {
  const m = new RegExp("const\\s+" + name + "\\s*=\\s*\\[([\\s\\S]*?)\\];").exec(uiBare);
  if (!m) return null;
  return Array.from(m[1].matchAll(/id:\s*"([^"]+)"/g)).map(function (x) {
    return x[1];
  });
};
const bootIds = tableIds("BOOT_STEPS");
const fullIds = tableIds("FULL_STEPS");
ok(
  "BOOT_STEPS is a prefix of FULL_STEPS, so the bar keeps its place",
  !!bootIds &&
    !!fullIds &&
    bootIds.length > 0 &&
    bootIds.length <= fullIds.length &&
    bootIds.every(function (id, i) {
      return fullIds[i] === id;
    }),
  bootIds && fullIds ? bootIds.join(",") + " -> " + fullIds.slice(0, bootIds.length).join(",") : "table not found",
);

// (4) The hand-off itself, and its escape hatch. The fallback matters more than
// the optimisation: if anything about running in this document is wrong on some
// other browser, the run still happens via jb.html instead of the entry point
// dying.
const runBody = /function run\(\)\s*\{([\s\S]*?)\n\}/.exec(bootPage);
ok(
  "boot.js hands off with an in-place import, not a navigation",
  !!runBody && /import\("\.\/jb\.js"\)/.test(runBody[1]) && /ui\.useRunSteps\(\)/.test(runBody[1]),
  'import("./jb.js")',
);
ok(
  "a failed single-page boot falls back to jb.html",
  !!runBody && /\.catch\([\s\S]*location\.replace\(toJb\(\)\)/.test(runBody[1]),
  "catch -> location.replace(toJb())",
);

// jb.html is still the direct entry point, so a bookmark or a mid-run reload
// reaches the run whether or not the landing page handed off in place.
ok(
  "jb.html remains a working direct entry point",
  /<script type="module" src="\.\/jb\.js">/.test(jbHtmlSrc) &&
    /id="stepList"/.test(jbHtmlSrc) &&
    /id="state"/.test(jbHtmlSrc),
  "loads jb.js, has the DOM jb.js reads",
);

// The run reads these two hidden sinks and location.search at its top level.
// They are identical in both pages, which is what makes the in-place import
// work at all -- so if one page ever drops one, this catches the asymmetry
// rather than the hand-off failing on a live console.
const idxHtmlSrc = await (await fetch("../index.html", { cache: "no-store" })).text();
for (const id of ["state", "out", "stepList", "logBody", "barFill"]) {
  const re = new RegExp('id="' + id + '"');
  ok(
    "both pages provide #" + id,
    re.test(idxHtmlSrc) && re.test(jbHtmlSrc),
    "index.html + jb.html",
  );
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
const total = rows.filter(function (r) {
  return r.name;
}).length;
document.body.className = failed ? "bad" : "ok";
document.getElementById("summary").textContent =
  (failed ? "FAILED" : "PASSED") + " -- " + (total - failed) + "/" + total + " checks";
document.getElementById("summary").className = failed ? "bad" : "ok";
const pre = document.getElementById("out");
let html = "";
for (const r of rows) {
  if (r.group) {
    html += '<div class="g">' + r.group + "</div>";
    continue;
  }
  html +=
    '<div class="r ' +
    (r.pass ? "ok" : "bad") +
    '"><span class="s">' +
    (r.pass ? "PASS" : "FAIL") +
    "</span><span class=n>" +
    r.name +
    '</span><span class="d">' +
    r.detail.replace(/&/g, "&amp;").replace(/</g, "&lt;") +
    "</span></div>";
}
pre.innerHTML = html;
globalThis.__check = { failed: failed, total: total, rows: rows };
