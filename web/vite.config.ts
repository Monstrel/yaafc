import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Identifies this build so open tabs can notice a newer deploy (see src/lib/updateCheck.ts).
const buildId = process.env.GITHUB_SHA ?? `local-${Date.now()}`

// https://vite.dev/config/
export default defineConfig({
  base: './',
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  // The solver's worker loads HiGHS with a top-level await, which needs an ES module worker.
  worker: { format: 'es' },
  plugins: [
    react(),
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
        for (const page of ['cauldron', 'saved', 'planner', 'changelog'])
          this.emitFile({ type: 'asset', fileName: `${page}.html`, source: index.source })
      },
    },
  ],
})
