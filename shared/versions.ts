/**
 * 基准版本号：提示词和交易引擎各自一个。
 *
 * 赛季开始时把当时的版本写进 seasons；如果代码升级后版本变了，页面会提示
 * “本赛季混用了两个版本”，建议开新赛季，避免同一份成绩无法解释。
 * 修改提示词、引擎规则或统计口径时，记得同步更新这里的版本号。
 */
export const PROMPT_VERSION = '2026-10-19.1'
export const ENGINE_VERSION = '2026-10-19.1'

/** 本次升级前创建的历史赛季没有记录版本，迁移时统一标成这个值 */
export const LEGACY_VERSION = 'legacy'
