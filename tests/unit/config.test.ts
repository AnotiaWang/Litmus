import { describe, expect, it } from 'vitest'
import { ConfigError, legacyEnvKeys, loadEnvConfig } from '../../server/lib/config'
import { ADMIN_TOKEN } from './helpers'

const BASE_ENV = { ADMIN_TOKEN }

describe('环境变量', () => {
  it('只需要面板口令；数据目录默认 ./data', () => {
    expect(loadEnvConfig(BASE_ENV)).toEqual({ adminToken: ADMIN_TOKEN, dataDir: './data' })
    expect(loadEnvConfig({ ...BASE_ENV, DATA_DIR: '/var/litmus' }).dataDir).toBe('/var/litmus')
  })

  it('ADMIN_TOKEN 未设置时拒绝启动，报错里不包含口令', () => {
    expect(() => loadEnvConfig({})).toThrow(ConfigError)
    expect(() => loadEnvConfig({ ADMIN_TOKEN: '   ' })).toThrow(/ADMIN_TOKEN/)
  })

  it('旧版本的变量（交易所 Key、LLM 连接、策略参数）不再参与校验，启动时列出来提示可以删掉', () => {
    const env = { ...BASE_ENV, BINANCE_API_KEY: 'k', LLM_MODEL: 'm', BUDGET_USDT: '-1', SMA_FAST: '' }
    expect(() => loadEnvConfig(env)).not.toThrow()
    expect(legacyEnvKeys(env)).toEqual(['BINANCE_API_KEY', 'LLM_MODEL', 'BUDGET_USDT'])
    expect(legacyEnvKeys(BASE_ENV)).toEqual([])
  })
})
