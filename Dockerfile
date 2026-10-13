# 两阶段构建：第一阶段安装依赖并构建，第二阶段只保留构建产物 .output/
# SQLite 用的是 Node 内置的 node:sqlite，不需要编译原生模块。

FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# 跳过 postinstall（nuxt prepare），下面的 pnpm build 会自己做
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8000 \
    # 收到停止信号后最多等 280 秒，让正在跑的一轮决策完成并记账。
    # LLM 超时最长 120 秒、失败重试 1 次，一轮最坏约 4 分钟；没有在跑的轮次时会立即退出
    NITRO_SHUTDOWN_TIMEOUT=280000
COPY --from=build /app/.output ./.output
RUN mkdir -p /app/data
EXPOSE 8000
CMD ["node", ".output/server/index.mjs"]
