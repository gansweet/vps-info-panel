# 面板本体（wrangler 本地运行时 + 本地 D1，数据保存在 /data）
FROM node:20-slim
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/* && npm i -g wrangler
WORKDIR /app
COPY worker.js wrangler.toml ./
ENV JWT_SECRET=change-me-please
EXPOSE 8787
VOLUME /data
CMD sh -c 'wrangler dev --ip 0.0.0.0 --port 8787 --persist-to /data --test-scheduled --var JWT_SECRET:$JWT_SECRET & sleep 15; while true; do curl -s http://127.0.0.1:8787/cdn-cgi/handler/scheduled >/dev/null; sleep 60; done'
