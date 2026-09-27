// boot.js -- the landing page: check the firmware, warm the cache, hand off.
//
// This replaces the inline <script> in the old index.html. Behaviour changes
// versus that version:
//
//  * 13.52 ONLY. The old page listed 13.02/13.04/13.50/13.52 and offered a
//    tap-to-override on anything else. This build has a single kernel table,
//    so an off-target console is stopped here, with no override, because the
//    alternative is writing 13.52 RVAs into a different kernel's .data.
//
//  * NO TAP GATE. The old page waited for a click/keypress after the appcache
//    finished downloading on a first run, and again on every cache update.
//    That was the single biggest source of "it just sits there" -- the page
//    looked stuck because it was waiting for an input that was easy to miss.
//    Caching now happens in the background and the run starts as soon as the
//    firmware check passes.
//
//  * FAIL FAST ON THE CACHE. If the offline cache cannot be built, the run is
//    still attempted rather than blocked behind a retry prompt.
//
//  * ONE DOCUMENT. The run happens here, in the page that is already open,
//    instead of a location.replace() into jb.html. See run() below.
//
//  * ENTRY COST IS MEASURED, NOT GUESSED. BOOT-TIME reports how long the
//    landing path took and how many bytes it pulled, so "the site feels slow to
//    load" is answerable with a number on the console rather than an opinion.

import { parseUa, SUPPORTED_FW } from "./ps4_offsets.js";
import * as ui from "./ui.js";

// Start the entry clock before anything else. now() is ui.js's monotonic
// source, so this shares a timebase with the phase spans it is compared
// against later.
const BOOT_T0 = performance.now();

// The landing page only has two steps, so switch the bar to the short table
// before init() paints it. Doing this after init() would flash the full
// fifteen-step list for one frame.
ui.useBootSteps();
ui.init();

const params = new URLSearchParams(location.search);

function toJb(extra) {
  const q = params.toString();
  const target = "jb.html" + (q ? (extra ? "&" + extra : "?" + q) : extra ? "?" + extra : "");
  return target;
}

function run() {
  // What the entry path actually cost, measured rather than assumed. This is
  // the number that answers "why does the site feel slow to open" on a real
  // console -- it is the time from this module starting to execute to the
  // exploit being able to begin. The warm downloads are deliberately not in it:
  // they are dispatched in parallel and the run does not wait for them, so
  // counting them here would report a number the user never actually waited.
  ui.log(
    "BOOT-TIME",
    "entry to hand-off " +
      Math.round(performance.now() - BOOT_T0) +
      "ms (no navigation, warm in parallel)",
    "info",
  );
  // The run happens in THIS document, not in a second navigation.
  //
  // index.html and jb.html are the same page -- identical DOM, four strings and
  // a script tag apart -- and location.replace() is a full teardown to get from
  // one to the other: re-fetch the document, re-parse it, rebuild every node,
  // re-run ui.init() against a fresh document, and throw away the progress bar
  // and console that were already on screen. The user watched the bar reach
  // 2/2 and then snap back to 0/15 on a blank page. All of that cost time and
  // none of it did any work, which made it the most visible delay between
  // arriving and the exploit starting.
  //
  // So the hand-off is a dynamic import into the document that is already
  // there. Three things had to be true for that, and all three are:
  //
  //   * ui.init() is idempotent (the S.booted guard), so jb.js's own call at
  //     its top level is a no-op rather than a double-bind of every handler.
  //   * ui.useRunSteps() reweights the bar, and reweight() carries the position
  //     across by step id. BOOT_STEPS is a prefix of FULL_STEPS, so the bar
  //     lands on the same phase it was already showing, just with the full
  //     table's weights.
  //   * jb.js reads #out, #state and location.search, and all three are
  //     identical here -- which is also why the parameter forwarding in
  //     toJb() is no longer on the fast path.
  //
  // jb.html is kept and still works as a direct entry point, so a bookmark or
  // a mid-run reload reaches the run either way. This is an optimisation to
  // the landing page, not a removal of the other one.
  ui.useRunSteps();
  import("./jb.js").catch(function (e) {
    // If running in this document fails for any reason -- a module graph that
    // will not resolve, a syntax error, a stale cached jb.js -- fall back to
    // the two-page flow. It costs one navigation in a case that should never
    // happen, and it means nothing here can brick the entry point.
    ui.log(
      "HANDOFF",
      "single-page boot failed, falling back to jb.html: " +
        (e && e.message ? e.message : String(e)),
      "warn",
    );
    location.replace(toJb());
  });
}

// ---------------------------------------------------------------------------
// Step 1: firmware
// ---------------------------------------------------------------------------
ui.setStep("boot");
const ua = parseUa(navigator.userAgent);
ui.sub(0.5, "user agent parsed");

if (!ua.off) {
  ui.log("FW", ua.key || "(not a PlayStation 4 user agent)", "bad");
  if (ua.key) {
    ui.log(
      "GATE-FAIL",
      ua.key +
        " -- this build supports " +
        SUPPORTED_FW +
        " only, and there is no override",
      "bad",
    );
  } else {
    ui.log(
      "GATE-FAIL",
      "the user agent does not identify a PS4 (" +
        String(navigator.userAgent).slice(0, 60) +
        ")",
      "bad",
    );
  }
  ui.finish(false, "requires " + SUPPORTED_FW);
} else {
  ui.sub(1, ua.key);
  ui.log("FW", ua.key, "ok");
  ui.log(
    "GATE",
    "single-firmware build -- " + SUPPORTED_FW + " is the only supported target",
    "ok",
  );
  ui.title("RAW GAME", "13.52 · " + ua.key);
  start();
}

// ---------------------------------------------------------------------------
// Step 2: warm the offline cache in the background, then run
// ---------------------------------------------------------------------------
function start() {
  ui.setStep("warm", "prefetching modules + payload");

  // Warm the module graph and the payload in parallel with the appcache
  // update. None of this has to finish before the run starts -- jb.js
  // re-requests anything that is not ready yet, and the cache means a second
  // run pays nothing -- but on a first run this overlaps ~380 KB of downloads
  // with the cache write instead of serialising them.
  //
  // The list is the WHOLE graph, not just the obvious three, and that detail
  // is the point. jb.js cannot call establishPrimitive() until its own imports
  // have arrived, so every module in that graph is serial latency sitting
  // immediately in front of the exploit starting. Only jb.js, the payload and
  // the patch blob used to be warmed, which left core.js (41 KB) and mem.js
  // (29 KB) to be fetched one after another on the critical path -- the
  // primitive could not begin until both had landed. ui.css is
  // render-blocking on jb.html, and rpc_worker.js is fetched mid-run by
  // `new Worker(...)` long after the page has settled.
  //
  // ps4_offsets.js and ui.js are deliberately absent: this module imports both
  // at the top, so they are already loaded and a second request would only add
  // a round trip.
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
  let warmBytes = 0;
  const warms = WARM.map(function (url) {
    return fetch(url)
      .then(function (r) {
        if (!r.ok) return null;
        return r.arrayBuffer().then(function (b) {
          warmBytes += b.byteLength;
          return b;
        });
      })
      .catch(function () {});
  });
  Promise.all(warms).then(function () {
    ui.sub(
      0.5,
      "assets warm (" + WARM.length + ", " + Math.round(warmBytes / 1024) + " KB)",
    );
  });

  // The offline cache is best-effort and never blocks the run.
  const ac = window.applicationCache;
  const hasManifest =
    !!ac && document.documentElement.hasAttribute("manifest");

  if (!hasManifest) {
    ui.log("CACHE", "no appcache on this page -- running online", "warn");
    ui.sub(1, "running");
    setTimeout(run, 0);
    return;
  }

  if (!navigator.onLine) {
    ui.log("CACHE", "offline -- using the cached copy", "ok");
    ui.sub(1, "offline, running from cache");
    setTimeout(run, 60);
    return;
  }

  if (ac.status === ac.UPDATEREADY) {
    try {
      ac.swapCache();
      ui.log("CACHE", "update applied", "ok");
    } catch (e) {
      ui.log("CACHE", "swapCache refused: " + (e && e.message), "warn");
    }
    // No reload: the page is already the new build's entry point, and a
    // reload would just add a round trip before the run.
    ui.sub(1, "running");
    setTimeout(run, 0);
    return;
  }

  if (ac.status === ac.IDLE) {
    ui.log("CACHE", "cached -- ready offline", "ok");
    ui.sub(1, "running");
    setTimeout(run, 0);
    return;
  }

  // A cache download is in flight. Start the run now and let it finish in the
  // background; the run only needs the assets it actually reads, and those are
  // being warmed above.
  ui.log("CACHE", "updating in the background -- not blocking the run", "warn");
  ac.addEventListener(
    "cached",
    function () {
      ui.log("CACHE", "cached for offline use", "ok");
    },
    false,
  );
  ac.addEventListener(
    "noupdate",
    function () {
      ui.log("CACHE", "already up to date", "ok");
    },
    false,
  );
  ac.addEventListener(
    "error",
    function () {
      ui.log("CACHE", "cache update failed -- continuing online", "warn");
    },
    false,
  );
  ui.sub(1, "running");
  setTimeout(run, 0);
}
