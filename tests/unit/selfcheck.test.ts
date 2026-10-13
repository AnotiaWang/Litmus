import { describe, expect, it } from 'vitest'
import type { LlmCall } from '../../shared/types/api'
import { describeReasoning } from '../../server/lib/selfcheck'

const call = (overrides: Partial<LlmCall> = {}): LlmCall => ({
  startedAt: '2026-10-08T12:00:00.000Z',
  durationMs: 1200,
  model: 'm',
  responseModel: 'm',
  reasoningEffort: null,
  jsonMode: true,
  httpStatus: 200,
  finishReason: 'stop',
  reasoning: null,
  content: '{}',
  usage: null,
  error: null,
  ...overrides
})

describe('自检 · LLM 思考过程说明', () => {
  it('返回了思考过程时给出字数和 token', () => {
    const text = describeReasoning(call({ reasoning: '先看趋势……', usage: { promptTokens: 900, completionTokens: 300, reasoningTokens: 250, totalTokens: 1200 } }), 'm', 'high')
    expect(text).toContain('返回了思考过程（6 字）')
    expect(text).toContain('思考用了 250 token')
    expect(text).toContain('本次共 1200 token')
  })

  it('有思考 token 但没有内容：提示服务没有透传', () => {
    expect(describeReasoning(call({ usage: { promptTokens: 1, completionTokens: 2, reasoningTokens: 50, totalTokens: 3 } }), 'm', 'high')).toContain('服务没有把内容传回来')
  })

  it('设置了思考强度却什么都没有：提示可能是代理没透传', () => {
    expect(describeReasoning(call(), 'm', 'high')).toContain('代理服务没有透传')
    expect(describeReasoning(call(), 'm', null)).toContain('不影响使用')
  })

  it('服务实际用的模型和请求的不一样时提醒', () => {
    expect(describeReasoning(call({ responseModel: 'other' }), 'm', null)).toContain('实际返回的是 other')
  })
})
