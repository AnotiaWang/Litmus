# 两阶段构建：第一阶段安装依赖并构建，第二阶段只保留构建产物 .output/
# SQLite 用的是 Node 内置的 node:sqlite，不需要编译原生模块。
# CVE-2026-111497（Brotli 解码器堆越界写）在 Node.js 24.22.1 修复。
# 构建与运行阶段都钉在该补丁版本，不要改回浮动的 node:24-slim。

FROM node:24.22.1-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# 跳过 postinstall（nuxt prepare），下面的 pnpm build 会自己做
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build

FROM node:24.22.1-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8000 \
    # 收到停止信号后最多等 280 秒，让正在跑的一轮决策完成并记账；没有在跑的轮次时会立即退出。
    # 各模型并行询问，默认超时 120 秒、失败重试 1 次，一轮最坏约 4 分钟。超时设得更长的模型可能等不完，
    # 被中断的模型这一轮不记账（模拟撮合，没有真实订单），下一轮会重新询问
    NITRO_SHUTDOWN_TIMEOUT=280000
COPY --from=build /app/.output ./.output
RUN mkdir -p /app/data
EXPOSE 8000
CMD ["node", ".output/server/index.mjs"]
