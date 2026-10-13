import { describe, expect, it } from 'vitest'
import { ConfigError, legacyEnvKeys, loadEnvConfig, settingsFromEnv } from '../../server/lib/config'
import { BinanceClient } from '../../server/lib/exchange'
import { BASE_ENV } from './helpers'

describe('配置校验', () => {
  it('默认值与文档一致', () => {
    const c = loadEnvConfig(BASE_ENV)
    expect(c.binance.baseUrl).toBe('https://demo-api.binance.com')
    expect(c.symbol).toBe('BTCUSDT')
    expect(c.llm).toMatchObject({ configured: true, reasoningEffort: null, timeoutMs: 30_000 })
  })

  it('testnet 使用测试网地址', () => {
    expect(loadEnvConfig({ ...BASE_ENV, BINANCE_ENV: 'testnet' }).binance.baseUrl).toBe('https://testnet.binance.vision')
  })

  it.each([
    'https://api.binance.com',
    'https://api1.binance.com',
    'https://api.binance.us',
    'https://demo-api.binance.com.evil.com'
  ])('配置真实交易所地址 %s 时拒绝启动', (url) => {
    expect(() => loadEnvConfig({ ...BASE_ENV, BINANCE_BASE_URL: url })).toThrow(ConfigError)
  })

  it('交易所客户端本身也拒绝白名单之外的地址', () => {
    expect(() => new BinanceClient({ baseUrl: 'https://api.binance.com', apiKey: 'k', apiSecret: 's' })).toThrow(/白名单/)
  })

  it('BINANCE_ENV 只能是 demo 或 testnet', () => {
    expect(() => loadEnvConfig({ ...BASE_ENV, BINANCE_ENV: 'live' })).toThrow(ConfigError)
  })

  it('ADMIN_TOKEN 未设置时拒绝启动，长度不限', () => {
    expect(() => loadEnvConfig({ ...BASE_ENV, ADMIN_TOKEN: undefined })).toThrow(/ADMIN_TOKEN/)
    expect(() => loadEnvConfig({ ...BASE_ENV, ADMIN_TOKEN: '' })).toThrow(/ADMIN_TOKEN/)
    expect(loadEnvConfig({ ...BASE_ENV, ADMIN_TOKEN: 'short' }).adminToken).toBe('short')
  })

  it('LLM 连接信息三项都不填表示不用 LLM；只填一部分时拒绝启动', () => {
    expect(loadEnvConfig({ ...BASE_ENV, LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '' }).llm.configured).toBe(false)
    expect(() => loadEnvConfig({ ...BASE_ENV, LLM_API_KEY: '' })).toThrow(/LLM_API_KEY/)
    expect(() => loadEnvConfig({ ...BASE_ENV, LLM_BASE_URL: 'llm.local/v1' })).toThrow(/LLM_BASE_URL/)
  })

  it('LLM_REASONING_EFFORT 可选，留空时为 null', () => {
    expect(loadEnvConfig(BASE_ENV).llm.reasoningEffort).toBeNull()
    expect(loadEnvConfig({ ...BASE_ENV, LLM_REASONING_EFFORT: '' }).llm.reasoningEffort).toBeNull()
    expect(loadEnvConfig({ ...BASE_ENV, LLM_REASONING_EFFORT: ' high ' }).llm.reasoningEffort).toBe('high')
    expect(() => loadEnvConfig({ ...BASE_ENV, LLM_REASONING_EFFORT: 'High!' })).toThrow(/LLM_REASONING_EFFORT/)
  })

  it('LLM 超时的默认值与校验', () => {
    expect(loadEnvConfig({ ...BASE_ENV, LLM_TIMEOUT_SECONDS: '90' }).llm.timeoutMs).toBe(90_000)
    expect(() => loadEnvConfig({ ...BASE_ENV, LLM_TIMEOUT_SECONDS: '300' })).toThrow(/LLM_TIMEOUT_SECONDS/)
  })

  it('已经改到面板里的旧变量：不再参与校验，启动时列出来提示', () => {
    const env = { ...BASE_ENV, BUDGET_USDT: '-1', INTERVAL_MINUTES: '5', SMA_FAST: '', LLM_ENABLED: 'false' }
    expect(() => loadEnvConfig(env)).not.toThrow()
    expect(legacyEnvKeys(env)).toEqual(['BUDGET_USDT', 'INTERVAL_MINUTES', 'LLM_ENABLED'])
    expect(legacyEnvKeys(BASE_ENV)).toEqual([])
  })

  it('回测时命令行传入的旧变量名转换成设置项', () => {
    expect(settingsFromEnv({ ...BASE_ENV, SIGNAL_MODE: 'cross', STOP_LOSS_PCT: ' 3 ', LLM_ENABLED: 'false', SMA_FAST: '' }))
      .toEqual({ signalMode: 'cross', stopLossPct: '3', llmEnabled: false })
  })

  it('报错信息里不包含密钥', () => {
    try {
      loadEnvConfig({ ...BASE_ENV, ADMIN_TOKEN: 'short', BINANCE_BASE_URL: 'https://api.binance.com' })
      expect.unreachable()
    } catch (e) {
      const msg = (e as Error).message
      for (const secret of [BASE_ENV.BINANCE_API_KEY, BASE_ENV.BINANCE_API_SECRET, BASE_ENV.LLM_API_KEY, 'short']) {
        expect(msg).not.toContain(secret)
      }
    }
  })
})
