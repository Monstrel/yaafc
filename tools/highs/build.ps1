# Builds the LP-only HiGHS the planner solves with, into web/src/vendor/highs. See README.md.
#
#   .\build.ps1 -Emsdk C:\emsdk [-WorkDir C:\hb] [-Tools C:\cmake\bin,C:\ninja]
#
# Needs git and node on PATH, an emsdk with the version below installed and activated, and CMake
# and Ninja (on PATH, or their folders in -Tools). Keep -WorkDir short: Windows' 260-character path
# limit breaks the build under a deep folder.
param(
  [Parameter(Mandatory)] [string]$Emsdk,
  [string]$WorkDir = "$env:TEMP\highs-build",
  [string[]]$Tools = @()
)

# The highs-js release whose JS glue and HiGHS source are built, and the emsdk it was built with.
# Changing either: rebuild, run the web tests, and check the patch still applies.
$HighsJsTag = 'v1.15.3'
$EmsdkVersion = '6.0.3'

$ErrorActionPreference = 'Continue' # native tools write progress to stderr: exit codes are checked instead
function Check($what) { if ($LASTEXITCODE) { throw "$what failed (exit $LASTEXITCODE)" } }

$here = $PSScriptRoot
$vendor = Join-Path $here '..\..\web\src\vendor\highs' | Resolve-Path
$repo = Join-Path $WorkDir 'highs-js'
$build = Join-Path $WorkDir 'build'

# emsdk's environment, as emsdk_env would set it.
$env:EMSDK = $Emsdk
$env:EM_CONFIG = Join-Path $Emsdk '.emscripten'
$python = Get-ChildItem (Join-Path $Emsdk 'python') -Recurse -Filter python.exe | Select-Object -First 1
$node = Get-ChildItem (Join-Path $Emsdk 'node') -Recurse -Filter node.exe | Select-Object -First 1
$env:EMSDK_PYTHON = $python.FullName
$env:PATH = (@("$Emsdk\upstream\emscripten", "$Emsdk\upstream\bin", $node.DirectoryName, $python.DirectoryName) + $Tools + $env:PATH) -join ';'
$version = (& emcc.exe --version | Select-Object -First 1)
if ($version -notmatch [regex]::Escape($EmsdkVersion)) { Write-Warning "emcc is '$version', not ${EmsdkVersion}: the output may differ" }

# A fresh highs-js at the pinned release, its HiGHS with the LP-only patch. Line endings as upstream,
# so the patch applies whatever git's autocrlf is.
if (Test-Path $repo) { Remove-Item $repo -Recurse -Force }
git -c core.autocrlf=false clone -q --depth 1 --branch $HighsJsTag --recurse-submodules --shallow-submodules https://github.com/lovasoa/highs-js.git $repo; Check 'clone'
git -C "$repo\HiGHS" -c core.autocrlf=false apply (Join-Path $here 'lp-only.patch'); Check 'patch'

# highs-js's runtime glue is TypeScript, compiled before the link.
Push-Location $repo
npm ci --ignore-scripts --no-audit --no-fund; Check 'npm ci'
& .\node_modules\.bin\tsc.cmd -p tsconfig.runtime.json; Check 'tsc'
Pop-Location

# The library, for size (-Os keeps solves within ~10% of -O3's speed; -Oz is smaller but ~30% slower).
New-Item -ItemType Directory -Force $build | Out-Null
Push-Location $build
$flags = '-Os -DNDEBUG -flto'
& emcmake.exe cmake --fresh "$repo\HiGHS" -G Ninja -DCMAKE_BUILD_TYPE=Release `
  "-DCMAKE_CXX_FLAGS_RELEASE=$flags" "-DCMAKE_C_FLAGS_RELEASE=$flags" `
  -DZLIB=OFF -DFAST_BUILD=OFF -DBUILD_SHARED_LIBS=OFF -DHIGHSINT64=OFF -DHIGHS_NO_DEFAULT_THREADS=ON `
  -DBUILD_TESTING=OFF -DBUILD_EXAMPLES=OFF -DBUILD_CXX_EXE=OFF; Check 'configure'
ninja highs; Check 'compile'

# Linked as highs-js links its ES module, exporting only what solve() and the glue's start-up use.
$libs = Get-ChildItem -Recurse -Filter *.a $build | ForEach-Object FullName
& emcc.exe -Os -flto `
  -s "EXPORTED_FUNCTIONS=@$(Join-Path $here 'exports.json')" `
  -s "EXPORTED_RUNTIME_METHODS=['cwrap','addFunction','removeFunction','UTF8ToString']" `
  -s MODULARIZE=1 -s EXPORT_ES6=1 -s ENVIRONMENT=web,worker,node `
  -s ALLOW_MEMORY_GROWTH=1 -s ALLOW_TABLE_GROWTH=1 -s STACK_SIZE=4194304 `
  -I "$repo\HiGHS\highs" -I $build `
  --pre-js "$repo\src\pre.js" --post-js "$repo\src\post.js" --post-js "$repo\build\generated\extended.js" `
  "$repo\src\highs_js_bridge.cpp" @libs -o "$build\highs.mjs"; Check 'link'
Pop-Location

Copy-Item "$build\highs.mjs", "$build\highs.wasm" $vendor -Force
Get-ChildItem $vendor -Filter 'highs.*' | ForEach-Object { '{0,-12} {1,10:N0} bytes' -f $_.Name, $_.Length }
