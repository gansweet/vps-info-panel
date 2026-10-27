# 探针镜像：静态链接 + scratch，约 1MB。构建：docker build -t vpsagent agent/
FROM alpine:3.20 AS b
RUN apk add --no-cache build-base openssl-dev openssl-libs-static
COPY vpsagent.c /s/
RUN gcc -O2 -Wall -static -DUSE_OPENSSL -o /vpsagent /s/vpsagent.c -lssl -lcrypto && /vpsagent -V
FROM scratch
COPY --from=b /vpsagent /vpsagent
COPY --from=b /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
ENTRYPOINT ["/vpsagent"]
