# RAW GAME — 13.52

A single-firmware build of the raw13g PS4 WebKit jailbreak loader, targeting
**PS4 13.52 only**, with a live progress bar and a log console that shows what
the run is doing at every step.

Original multi-firmware source: `raw13g.github.io`. This directory is a
self-contained, 13.52-only derivative. The original is untouched.

---

## What changed

### 1. Single firmware, hard gate

`ps4_offsets.js` now contains exactly one entry, `13.52`. The 13.02 / 13.04 /
13.50 tables are gone, and the 13.52 values are inlined rather than derived
from another entry at runtime.

The loader stops on anything that is not 13.52, and **there is no override**.
The upstream `index.html` had a tap-to-override for unlisted firmware. That is
deliberately removed: a 13.52 RVA table applied to a different kernel means
writing into kernel `.data` at the wrong address, which is a brick rather than
an error message. If you need 13.50 or older, use the upstream build.

The gate accepts a UA of the form `Mozilla/5.0 (PlayStation 4/13.52) …`. The
UA minor is parsed as **hex**, so `/13.5A` really is a 13.50.

### 2. Faster loader

- **No tap gates.** Upstream waited for a click after the appcache finished on
  a first run, and again on every cache update. That was the single largest
  source of "it just sits there". Caching is now background work and the run
  starts as soon as the firmware check passes.
- **Fail-open on the cache.** If the offline cache cannot be built, the run is
  attempted online instead of being blocked behind a retry prompt.
- **Parallel warm.** `boot.js` prefetches `jb.js`, `goldhen.bin` and
  `patches/1352.bin` concurrently with the cache update instead of after it.
  `jb.js` also kicks off its own warm before the primitive is tested, so the
  payload is already in memory by the time it is needed.
- **Batched UI writes.** All log/console/bar writes are coalesced into one DOM
  pass per frame. Upstream rebuilt the entire `<pre>` with `innerHTML` on every
  single log line, which is O(n²) over a 400-line run.
- **One module instance of `core.js`.** `jb.js` and `mem.js` now both import
  plain `./core.js`. Upstream's `core.js?v=10` plus a bare `core.js` in the
  manifest meant two specifiers for one file; they are the same URL now.

### 3. Fast injection

`mem.js` gained `writeInto(src, addr, count)` and `compareAt(expected, addr,
count)`. The primitive's carrier window is capped at `0x100` bytes by
`aimFor`, and each `write8` costs a full aim/restore round trip. Injecting the
293 KB payload byte-by-byte meant ~36 000 round trips; `writeInto` does one per
`0x100` window instead — about 2 240. Verification goes from one compare per
byte to one per window.

`writeInto`/`compareAt` are also exposed on the global `p` object alongside
`readInto`/`read8`.

#### What was removed from the critical path

Four latency costs were pure overhead — the work did not change, only *when* it
happened:

- **The whole module graph is warmed, not three files.** `jb.js` cannot call
  `establishPrimitive()` until its own imports have arrived, so every module in
  that graph is serial latency sitting immediately in front of the exploit
  starting. Only `jb.js`, the payload and the patch blob used to be warmed,
  which left `core.js` (41 KB) and `mem.js` (29 KB) to be fetched one after
  another before the primitive could even begin. `ui.css` is render-blocking on
  `jb.html` and `rpc_worker.js` is fetched mid-run by `new Worker(...)`. All
  eight now go out in parallel from the landing page. `tools/check.js` derives
  the requirement from `jb.js`'s actual imports, so the list cannot rot.
- **Both workers are brought up at once.** `bringWorker()` is a Worker spawn
  plus five postMessage round trips, and it used to run back to back, so `w2`'s
  handshake could not start until `w1`'s last reply landed. The two handshakes
  are independent: separate Worker, separate port, separate heap objects. The
  only shared state is the carrier, which is safe because `aim()` and `restore()`
  are separated by no `await` and JavaScript is single-threaded — each `read8` /
  `write8` window stays atomic however the two interleave.
- **The two `getpid` probes go out together** rather than as two sequential
  kernel crossings.
- **The park wait is a FIFO barrier, not a 250 ms sleep.** `spin()` is an
  infinite loop and never answers, so the old code posted it and hoped. But a
  worker's message queue is ordered: a `ping` posted immediately before the spin
  means that when the reply arrives, everything queued ahead of the spin is done
  and the spin is all that is left — which is exactly the condition the sleep was
  guessing at. Now it waits for that fact, then allows 30 ms of grace. A worker
  that is merely *idle* is safe (it issues no syscalls), so the short grace
  cannot reintroduce the hazard the sleep was guarding against. If the barrier
  times out it falls back to the full wait rather than proceeding on a guess.

#### The second entry win: one document, not two

`index.html` and `jb.html` are the same page — identical DOM, four strings and a
script tag apart — and `boot.js` reached the run with `location.replace()`. That
is a full teardown to move between two nearly identical pages: re-fetch the
document, re-parse it, rebuild every node, re-run `ui.init()` against a fresh
document, and throw away the progress bar and console that were already on
screen. The user watched the bar reach 2/2 and then snap back to 0/15 on a blank
page. All of that cost time and none of it did any work.

The run now happens in the document that is already open, via
`import("./jb.js")`. Three things had to hold, and `tools/check.js` asserts each:

- **`ui.init()` is idempotent** (the `S.booted` guard), so `jb.js`'s own call at
  its top level is a no-op instead of double-binding every button handler.
- **`BOOT_STEPS` is a prefix of `FULL_STEPS`** — same `boot` and `warm` ids at
  the front, different weights. `reweight()` carries the bar's position across
  by id, so the bar lands on the phase it was already showing: mid-"Warming
  assets" at 1/2 becomes 2/15, still on "Warming assets".
- **Both pages carry the sinks `jb.js` reads** (`#out`, `#state`, `#stepList`,
  `#logBody`, `#barFill`) and `jb.js` takes its parameters from
  `location.search`, so nothing has to be forwarded and the two pages cannot
  drift apart unnoticed.

Two things improve as a side effect. The boot-phase log lines now survive into
the run, so the console reads as one continuous session rather than resetting at
step 3. And the navigation was killing three in-flight warm fetches on its way
out, so all eight now complete.

`jb.html` is kept and still works as a direct entry point, and the in-place
import is wrapped in a `.catch()` that falls back to `location.replace(toJb())`.
If anything about running in one document is wrong on some other browser, the
run still happens — one navigation in a case that should never occur, rather than
a dead entry point.

#### Two things that looked like bottlenecks and were not

Both were measured by reading the code rather than assumed, and optimizing
either would have been risk for no gain:

- **The syscall-page sweeps.** They stride 0x40000 bytes 16 at a time and
  `findStub()` ran three of them, so ~65 000 `read8` calls. But `read8` is
  `aim()` + 8 typed-array reads + `restore()` — in-page memory, no I/O, no
  syscall. ~24 memory operations each, so the lot is sub-millisecond.
- **The kernel arena fill.** `KA = 32768` nodes looks alarming, but `wnode()`
  writes into a *local* `DataView` that is handed to the kernel in one
  `setsockopt`. It is a JS buffer fill, not 32 768 round trips.

#### What was deliberately not touched

The primitive establishment and the `aio_multi` chain are the exploit. They are
timed by the target, not by this code, and they are where essentially all of the
remaining wall-clock lives. Retuning their constants would trade "fully working"
for "faster", which is the wrong end of that trade.

`core.js` is byte-identical to upstream. Its `?g=` override exists and is
deliberately unused — it is the same lever, pointed at the primitive timings.

#### Measuring it

Speed claims are guesswork without evidence, because the time is in a WebKit heap
race and a kernel race that the source does not show. So each step now records
its own wall clock, the step list prints the figure next to each phase, and the
run ends with a `PHASE-TIME` line ranking the slowest phases:

```
PHASE-TIME  measured 13 phases, 4678ms total | slowest: Kernel read/write
            tests 773ms  Arbitrary R/W primitive 512ms  ...
```

On the console, that line is the difference between "it is slow" and knowing
which phase to look at. `tools/uitest.html?assert=1` asserts the numbers are
sound.

There is a matching figure for the entry path, because "the site is slow to
open" deserves a number too:

```
BOOT-TIME  entry to hand-off 136ms (no navigation, warm in parallel)
```

That is the time from `boot.js` starting to execute to the exploit being able to
begin, on a real console. The warm downloads are deliberately excluded: they are
dispatched in parallel and the run never waits on them, so counting them would
report a latency nobody actually sat through. The subtitle carries their real
size instead (`assets warm (8, 385 KB)`).

### 4. Progress bar

`ui.js` owns a 15-step weighted bar. Steps are weighted by real cost, so the
primitive and the race pool — which dominate wall-clock — move the bar most.

The bar is honest about failure, which is the part that matters:

- On a run rejected by the firmware gate it stops at **0%**, step 1. It does
  not walk forward through teardown and report.
- On a run that throws mid-exploit it stops **where it actually stopped**. The
  bar shows how far the run got, not how far the code got to reading.
- Only a run where the payload thread is confirmed running reports success
  (`RUN-VERDICT` / the `payloadRunning` flag), so a green bar cannot hide a run
  that ended earlier.

### 5. Log console

Every step of the run is logged, with a timestamp, a tag, and a level. Controls:

| control | what it does |
| --- | --- |
| `all` | every line |
| `steps` | phase and step lines only |
| `proofs` | `PROOF-OK` / `PROOF-FAIL` only |
| `copy` | copy the whole log to the clipboard |
| `clear` | clear the console |
| `collapse` | fold the console away to leave just the bar |
| `N of M` | lines shown vs. lines emitted (the DOM is capped) |

A verdict panel shows the jailbreak-relevant proofs (jailbreak, KRW, kernel
patch, payload, uid) so you can see the outcome without reading 400 lines.

---

## URL parameters

### Added by this build

| param | default | meaning |
| --- | --- | --- |
| `?net=1` | off | POST the log to `/t`. **Batched**, one request per 500 ms, not one per line. Upstream did this unconditionally, which is hundreds of requests per run. |
| `?maxlines=N` | `400` | cap on console lines. The counter shows `N of M`. |
| `?quiet=1` | off | fold the console away, leave just the bar. `copy` still gets every line. |

### Inherited from upstream

| param | meaning |
| --- | --- |
| `?jb=0` | skip the jailbreak stage |
| `?patch=0` | skip the kernel patch stage |
| `?payload=0` | skip payload injection |
| `?skipjb=0` | run jailbreak even if it looks already done |
| `?keepjb=1` | leave the jailbreak in place afterwards |
| `?retry=N` | retry count |
| `?attempts=N` | primitive attempts |
| `?verbose=1` | no terse-ing of long log lines |

---

## Files

| file | role |
| --- | --- |
| `index.html` | landing page: firmware check, warm, then runs the exploit in this same document |
| `boot.js` | the landing page's logic (was inline) |
| `jb.html` | the run page — kept as a direct entry point and the fallback if the in-place import fails |
| `jb.js` | the exploit. Its 3 800-line run body is unchanged from upstream |
| `ui.js` | progress bar, step list, log console, verdicts, final banner |
| `ui.css` | loader chrome |
| `ps4_offsets.js` | 13.52-only offset table + `parseUa()` |
| `mem.js` | the primitive; gained `writeInto` / `compareAt` |
| `core.js` | **unmodified** from upstream |
| `int64.js`, `rpc_worker.js` | **unmodified** from upstream |
| `goldhen.bin` | payload, 293 120 bytes |
| `patches/1352.bin` | kpatch blob, 632 bytes |
| `cache.appcache` | offline cache manifest |

`tools/` is development-only and is not in the appcache manifest:

| file | role |
| --- | --- |
| `check.html` | static build checks — run this after any edit |
| `uitest.html` | replays a recorded run through the UI in any browser |
| `warmtest.html` | exercises `boot.js`'s warm + hand-off, which is otherwise unreachable off-console |
| `hash.ps1` | regenerates the appcache hashes |

---

## Verifying a change

`core.js` is untouched, and nothing here can be exercised end-to-end without a
13.52 console. Two tools cover the rest.

**`tools/check.html`** — 75 checks: every `REQUIRED_KEYS` / `OPTIONAL_KEYS`
name is present in the 13.52 table, the table has exactly one entry, the UA gate
accepts 13.52 and rejects six other user agents, every runtime file is present
at the expected size, all eight of `boot.js`'s warm-fetch targets resolve, the
appcache manifest lists every runtime file, contains no stale entries, has no
UTF-8 BOM, and **every manifest hash matches the file on disk**. The last group
greps the shipped sources for any code path that could still reach another
firmware's table or patch blob.

Three further groups guard changes that would otherwise fail silently:

- **"latency and phase timing"** pins the concurrency/timing edits that are
  one-line, silent, and worth ~300 ms a run.
- **"every jb.js import is warmed"** derives the warm list's requirement from
  `jb.js`'s actual imports, so it cannot rot when a module is added.
- **"single-page hand-off"** asserts the four assumptions the in-place import
  rests on: that `ui.init()` is idempotent, that `useRunSteps()` is exported,
  that `BOOT_STEPS` is a prefix of `FULL_STEPS` (so the bar keeps its place
  across the table switch), and that the `.catch()` still falls back to
  `jb.html`. Each was proven to fire by breaking it.

**`tools/uitest.html`** — drives the real `ui.js` with a recorded tag sequence,
so the bar, step list, console filters, verdicts panel and final banner can be
reviewed in a desktop browser:

```
tools/uitest.html                    successful run
tools/uitest.html?case=fail          stopped mid-run
tools/uitest.html?case=gate          rejected by the firmware gate
tools/uitest.html?slow=1             one line per 120 ms
tools/uitest.html?assert=1           asserts the phase timings, then prints a pass/fail block
tools/uitest.html?maxlines=12        console cap
tools/uitest.html?quiet=1            console folded away
```

`?assert=1` is the one that matters for the timing. It checks the *numbers*
rather than the pixels: that real gaps are measured as real milliseconds, that
every phase the replay entered gets closed (including the last, which only
`finalize()` can close), that no phase is credited to a step the run never
reached, and that the spans do not overlap. It found a real bug — a phase
lasting 0 ms was being dropped by a `spent > 0` guard, so the final phase showed
no figure at all roughly one run in three depending on timer jitter.

Both tools take `&v=N` to bust the browser's module cache. Without it, editing
`ui.js` and reloading can silently serve the old module — the same trap as a
stale appcache hash, and it cost real time while building this. `check.html`
takes the parameter on the *page* URL and passes it down to both its own script
and the `ps4_offsets.js` import; a hardcoded `?v=` on the script tag only works
if someone remembers to bump it by hand, and when they forget the page reports
the previous run's green result against code that no longer exists.

**`tools/warmtest.html`** — `boot.js` gates on `navigator.userAgent`, so on a
desktop it rejects at the firmware check and the warm path never runs at all.
This spoofs a 13.52 UA and records every URL `boot.js` fetches along with its
HTTP status and byte count. That recording matters because `boot.js` swallows a
failed warm in a `.catch(function(){})`: a 404 there is completely invisible in
its own log and only shows up later as a slow run.

It is also the only way to exercise the single-page hand-off, since the real
`index.html` never gets past the gate off-console. Under the old
`location.replace()` flow the harness had to stash its results in
`sessionStorage` and read them back from `jb.html`, because `Location` methods
are unforgeable and a stubbed `location.replace` silently fails to install. Now
that the run stays in one document there is nothing to navigate away from, so
the results are simply read off the live page — and all eight warm fetches
complete, where the navigation used to kill three in flight.

---

## After editing any cached file

```
powershell -ExecutionPolicy Bypass -File tools\hash.ps1
```

Then re-open `tools/check.html`. A stale manifest hash does not fail loudly —
appcache keeps serving the old copy out of the console's storage and the edited
code never runs, which looks exactly like "my change did nothing".

The script writes UTF-8 **without** a BOM on purpose. A BOM in front of
`CACHE MANIFEST` makes the browser reject the manifest as malformed, and the
console then quietly runs online-only with nothing in the log to say why.

---

## Scope of changes, honestly

- Everything that touches the kernel is **unchanged** from upstream. The
  primitive, the race pool, the base leak, the gadget chain, the syscall stubs,
  the kpatch write and the payload write are the same code against the same
  13.52 offsets. Nothing here is retuned.
- `core.js` is byte-identical to upstream. It has a `?g=` override that could
  retune primitive timings; it was deliberately left alone rather than used to
  trade stability for speed.
- The `writeInto` / `compareAt` change is an injection-throughput change only.
  It does not alter what gets written, only how many aim/restore round trips it
  takes to write it.
- The three latency changes (concurrent worker bring-up, parallel `getpid`,
  barrier-based park wait) change *when* work happens, not what the exploit does.
  The barrier in particular is a stronger guarantee than the sleep it replaces:
  it confirms the condition the sleep was assuming.
- The per-phase timing is measurement only. It reads the clock and prints; it
  cannot change the run.
- The multi-firmware table is not recoverable from this directory. If you need
  it, the upstream source is unchanged.
