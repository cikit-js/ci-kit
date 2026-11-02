import type { BuildConfig } from 'unbuild'
import { defu } from 'defu'

const commonBuildConfig: BuildConfig = {
  rollup: {
    esbuild: {
      minify: false
    },
    inlineDependencies: false,
    dts: {
      respectExternal: true
    }
  },
  clean: true,
  declaration: true
}

export function mergeDefaultBuildConfig(config: BuildConfig): BuildConfig {
  return defu(commonBuildConfig, config)
}
