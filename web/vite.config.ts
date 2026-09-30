import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Identifies this build so open tabs can notice a newer deploy (see src/lib/updateCheck.ts).
const buildId = process.env.GITHUB_SHA ?? `local-${Date.now()}`

// https://vite.dev/config/
export default defineConfig({
  base: './',
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [
    react(),
    {
      name: 'version-json',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: buildId }) })
      },
    },
  ],
})
