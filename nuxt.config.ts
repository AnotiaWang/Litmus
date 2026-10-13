// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui'
  ],

  // 面板需要口令且数据都在浏览器端拉取，不需要服务端渲染
  ssr: false,

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  compatibilityDate: '2026-06-30',

  nitro: {
    experimental: {
      tasks: true
    }
  },

  // 测试和 vitest 配置也纳入 pnpm typecheck
  typescript: {
    nodeTsConfig: {
      include: ['../tests/**/*', '../vitest.config.ts']
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
