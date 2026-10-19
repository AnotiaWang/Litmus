<script setup lang="ts">
/** 方法说明：数据来源、撮合假设、决策节奏、风控、提示词版本和局限性。 */
import { ENGINE_VERSION, PROMPT_VERSION } from '#shared/versions'

useSeoMeta({ title: '方法 · Litmus' })
</script>

<template>
  <div class="space-y-6">
    <UButton
      to="/"
      color="neutral"
      variant="link"
      icon="i-lucide-arrow-left"
      class="px-0"
    >
      返回排行榜
    </UButton>

    <UCard>
      <template #header>
        <h1 class="text-xl font-semibold">
          这个基准怎么跑
        </h1>
        <p class="text-sm text-muted">
          Litmus 用同一份行情、同样的初始资金和风控，让多个模型各自做买入 / 卖出 / 观望决策，按结果排名。
        </p>
      </template>
      <div class="space-y-4 text-sm/relaxed text-muted">
        <p>
          所有交易都是<strong class="text-default">模拟撮合</strong>，不连接交易所账户，也不会真实下单。行情来自 Binance 公开行情接口，不需要 API Key。
        </p>
      </div>
    </UCard>

    <UCard>
      <template #header>
        <h2 class="font-semibold">
          行情与撮合假设
        </h2>
      </template>
      <ul class="list-inside list-disc space-y-2 text-sm text-muted">
        <li>每轮取一次已收盘 K 线和当前价格，同一轮所有模型使用同一份快照。</li>
        <li>成交按快照价格模拟，手续费 0.1%；不模拟滑点、盘口深度和资金费率。</li>
        <li>只做现货多头，不能做空、不能加杠杆；卖出只能卖账本里已有的币。</li>
        <li>成交遵守交易所的数量步长、最小数量和最小下单额。</li>
        <li>模型回得慢不影响成交价；一个模型出错不影响其他模型。</li>
      </ul>
    </UCard>

    <UCard>
      <template #header>
        <h2 class="font-semibold">
          决策节奏与风控
        </h2>
      </template>
      <ul class="list-inside list-disc space-y-2 text-sm text-muted">
        <li>每根赛季设定的 K 线收盘后询问一次 LLM；两次询问之间只检查止损、记录资产。</li>
        <li>程序每轮检查止损；跌破止损线时不等模型，直接全部卖出。</li>
        <li>风控在模型决定之上执行：当日亏损熔断、每日笔数、冷却、单笔上限、仓位上限、最小下单额。只会调小金额或拦下交易。</li>
        <li>卖出不受单笔上限、每日笔数和冷却约束；当日亏损熔断期间也照常卖出。</li>
        <li>赛季规则在赛季开始时定下，赛季内不能改；换规则要开新赛季。</li>
      </ul>
    </UCard>

    <UCard>
      <template #header>
        <h2 class="font-semibold">
          提示词与版本
        </h2>
      </template>
      <div class="space-y-3 text-sm text-muted">
        <p>
          发给模型的是已收盘 K 线、程序算好的行情摘要、账本、持仓、止损线、风控状态和它最近几次决策。刻意不提供 SMA、RSI 这类指标，避免模型直接套用均线基线的规则。
        </p>
        <p>
          当前代码版本：<code class="rounded bg-elevated px-1.5 py-0.5">prompt {{ PROMPT_VERSION }}</code>
          <code class="ml-2 rounded bg-elevated px-1.5 py-0.5">engine {{ ENGINE_VERSION }}</code>。
          赛季开始时会把当时的版本写进赛季；如果页面提示版本不一致，说明中途升级过，建议开新赛季。
        </p>
        <p>
          每条决策都可以在榜单或模型详情里展开，查看提示词、思考过程、原始输出、耗时和 token 用量。
        </p>
      </div>
    </UCard>

    <UCard>
      <template #header>
        <h2 class="font-semibold">
          时间与局限
        </h2>
      </template>
      <ul class="list-inside list-disc space-y-2 text-sm text-muted">
        <li>页面显示浏览器本地时间；行情快照、提示词、每日成交统计和熔断日切使用 UTC（UTC 0 点 = 北京时间 08:00）。</li>
        <li>几天的收益差异很可能只是噪声。榜单会显示样本量和 t 值，建议至少 30 天 / 100 笔交易后再比较。</li>
        <li>模型输出有随机性；同一个模型在不同服务商、不同思考强度下的表现也可能不同。</li>
        <li>行情只包含价格和成交量，不含新闻、资金费率、链上数据等外部信息。</li>
        <li>本项目的成绩只说明“这段行情里这个模型这样决策会怎样”，不代表未来，也不构成投资建议。</li>
      </ul>
    </UCard>
  </div>
</template>
