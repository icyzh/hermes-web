import path from 'path'
import { defineConfig } from 'vitest/config'

const DESKTOP_SRC = path.resolve(__dirname, '../desktop/src')

export default defineConfig({
  resolve: {
    alias: {
      '@': DESKTOP_SRC,
      '@hermes/plugin-sdk': path.resolve(DESKTOP_SRC, 'sdk/index.ts'),
      '@hermes/shared/billing': path.resolve(__dirname, '../shared/src/billing-types.ts'),
      '@hermes/shared': path.resolve(__dirname, '../shared/src')
    }
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'jsdom'
  }
})
