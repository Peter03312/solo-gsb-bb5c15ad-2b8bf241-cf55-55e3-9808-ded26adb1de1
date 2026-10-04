# better-sqlite3 为原生模块，需在镜像内编译；node:20 基础镜像自带构建工具链
FROM node:20-bookworm-slim

# better-sqlite3 预编译二进制在部分平台不可用时退回源码编译
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 优先拷贝依赖清单，利用 Docker 层缓存
COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/lab.db

EXPOSE 3000
VOLUME ["/app/data"]

# 容器启动即安装依赖（已在构建层完成）并初始化数据库/示例数据
CMD ["node", "src/server.js"]
