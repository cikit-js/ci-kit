import { defineConfig } from '@initx-plugin/env'

export default defineConfig({
  schema: 1,
  storage: {
    type: 'github',
    apiBaseUrl: 'https://api.github.com',
    repo: 'imba97/env',
    branch: 'main',
    path: 'stores'
  }
})
