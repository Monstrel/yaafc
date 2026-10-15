# LP-only HiGHS

The planner solves its plans with [HiGHS](https://highs.dev) compiled to WebAssembly by
[highs-js](https://github.com/lovasoa/highs-js). The npm package builds all of HiGHS, for speed: 3.5 MB
of wasm (1.2 MB gzipped). The planner only solves plain LPs, with the dual simplex, so it ships its
own build instead, in `web/src/vendor/highs/`: 1.3 MB (0.5 MB gzipped).

What's different from the package's build:

- **No MIP, QP or interior-point solvers.** `lp-only.patch` turns their call sites into errors (MIP,
  QP, IPX, HiPO, PDLP and IPX crossover), so the linker drops them. LPs take the same path as before.
- **Compiled for size** (`-Os` with LTO) rather than `-O3`. Solves run about 10% slower; `-Oz` downloads
  0.07 MB less (gzipped) but solves about 30% slower.
- **Only the C functions `solve()` uses are exported** (`exports.json`), plus the few the glue calls
  as it loads. The rest of highs-js's API is left out and fails if called; `highs.d.mts` types only
  `solve()`.

Built from highs-js v1.15.3 (HiGHS 1.15.1) with emsdk 6.0.3, it solves every LP in the web tests to
the same status and the same values, bit for bit, as the package.

## Rebuilding

Only needed to move to another HiGHS. On Windows, with git and node on PATH:

1. Install [emsdk](https://github.com/emscripten-core/emsdk) and `emsdk install 6.0.3` (run
   `python emsdk.py install 6.0.3` if `emsdk.bat` can't find Python), plus CMake and Ninja.
2. `.\build.ps1 -Emsdk C:\emsdk -WorkDir C:\hb -Tools <cmake bin folder>,<ninja folder>`. Keep
   the work folder's path short: past 260 characters, Windows breaks the build.
3. Run the web tests (`npm test` in `web/`).

To move to a newer highs-js, change `$HighsJsTag` and `$EmsdkVersion` in `build.ps1` to that
release's (its `.env` names the emsdk), and the `highs` dev dependency in `web/package.json`, which
supplies the types. If the patch no longer applies, redo it against the new HiGHS. If the glue fails
to load, it calls a C function at start-up that `exports.json` leaves out: add it.
