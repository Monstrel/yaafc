/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Identifies this build so open tabs can notice a newer deploy (see src/lib/updateCheck.ts).
const buildId = process.env.GITHUB_SHA ?? `local-${Date.now()}`
// Shown in the footer with the build id, so a bug report can be matched to a deploy.
const buildTime = new Date().toISOString().slice(0, 16) + 'Z'
// Deploys in order, so a tab can tell when a newer build saved the player's data (see src/lib/store.ts).
const buildRun = Number(process.env.GITHUB_RUN_NUMBER) || 0

// https://vite.dev/config/
export default defineConfig({
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
    __BUILD_TIME__: JSON.stringify(buildTime),
    __BUILD_RUN__: JSON.stringify(buildRun),
  },
  // The solver's worker loads HiGHS with a top-level await, which needs an ES module worker.
  worker: { format: 'es' },
  // The heaviest solver tests take seconds here and several times that on GitHub's runners.
  test: { testTimeout: 60_000, setupFiles: ['./src/test/rowsExist.ts'] },
  plugins: [
    react(),
    {
      // The Reference's notes (src/lib/notes.ts) live outside web/, which the dev server only
      // watches for files already loaded: watch their folder, so a note added while it runs shows.
      name: 'watch-reference-notes',
      apply: 'serve',
      configureServer(server) {
        server.watcher.add(fileURLToPath(new URL('../reference', import.meta.url)))
      },
    },
    {
      name: 'version-json',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: buildId }) })
      },
    },
    {
      // GitHub Pages serves /planner from planner.html, so each page's address opens the app.
      name: 'page-html',
      apply: 'build',
      enforce: 'post',
      generateBundle(_, bundle) {
        const index = bundle['index.html']
        if (index?.type !== 'asset') return
        for (const page of ['cauldron', 'saved', 'planner', 'reference', 'xray', 'changelog'])
          this.emitFile({ type: 'asset', fileName: `${page}.html`, source: index.source })
      },
    },
  ],
})
