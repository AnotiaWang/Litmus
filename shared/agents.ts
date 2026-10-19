/**
 * Provider 和模型的表单校验，前后端共用。
 *
 * Provider 是一个 OpenAI 兼容接口（地址 + Key）；模型挂在 Provider 下。
 * 模型开始参赛后，决定它“是谁”的字段（Provider、模型名、思考强度、额外参数）就不能再改，
 * 否则同一条曲线里混着两个模型；要换就新建一个。显示名、颜色、超时随时可以改。
 */
import { z } from 'zod'

/** 模型曲线的默认配色，新建模型时按顺序取第一个没被占用的 */
export const AGENT_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c',
  '#0891b2', '#db2777', '#65a30d', '#4f46e5', '#ca8a04'
] as const

/** 均线基线的颜色（灰色），和模型区分开 */
export const BASELINE_COLOR = '#64748b'

const name = z.string().trim().min(1, '必填').max(60, '不能超过 60 个字')
const color = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, '颜色格式如 #2563eb')

export const providerInputSchema = z.object({
  name,
  baseUrl: z.string().trim().regex(/^https?:\/\/\S+$/, '必须以 http:// 或 https:// 开头').transform(v => v.replace(/\/+$/, '')),
  apiKey: z.string().trim().min(1, '必填')
})
export type ProviderInput = z.output<typeof providerInputSchema>

/** 修改 Provider：Key 留空表示不改 */
export const providerUpdateSchema = providerInputSchema.extend({
  apiKey: z.string().trim().optional().transform(v => v || undefined)
})

/** 额外请求参数：原样合并进 /chat/completions 的请求体，用来开启各家不同的思考参数等 */
const extraParams = z.record(z.string(), z.unknown()).nullable().default(null).refine(
  v => !v || !['model', 'messages'].some(k => k in v),
  '不能覆盖 model 和 messages'
)

export const agentInputSchema = z.object({
  providerId: z.coerce.number().int().positive('请选择 Provider'),
  /** 请求时发送的模型名 */
  model: z.string().trim().min(1, '必填').max(200),
  name,
  color: color.optional(),
  /** 思考强度（reasoning_effort），原样发送；留空则不发送，用模型默认值 */
  reasoningEffort: z.string().trim().regex(/^[a-z]*$/, '只能是小写英文单词，如 low、medium、high').nullable().default(null).transform(v => v || null),
  /** 单次请求最多等多少秒，超时重试 1 次 */
  timeoutSeconds: z.coerce.number().int('必须是整数').min(5, '不能小于 5').max(600, '不能大于 600').default(120),
  /** 可选的 token 单价（每百万 token，美元），只用于面板估算成本，不影响交易 */
  inputPricePerM: z.preprocess(v => v === '' || v === null || v === undefined ? null : v, z.coerce.number().min(0, '不能小于 0').max(100000, '数值过大').nullable().default(null)),
  outputPricePerM: z.preprocess(v => v === '' || v === null || v === undefined ? null : v, z.coerce.number().min(0, '不能小于 0').max(100000, '数值过大').nullable().default(null)),
  extraParams
})
export type AgentInput = z.output<typeof agentInputSchema>

/** 修改模型：只能改显示名、颜色、超时和成本单价 */
export const agentUpdateSchema = z.object({
  name,
  color,
  timeoutSeconds: agentInputSchema.shape.timeoutSeconds,
  inputPricePerM: agentInputSchema.shape.inputPricePerM,
  outputPricePerM: agentInputSchema.shape.outputPricePerM
})
export type AgentUpdate = z.output<typeof agentUpdateSchema>
