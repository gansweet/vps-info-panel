FROM alpine:3.20 AS b
RUN apk add --no-cache build-base pkgconf curl-dev curl-static openssl-libs-static zlib-static nghttp2-static brotli-static c-ares-static libidn2-static libunistring-static zstd-static
COPY vpsagent.c /s/
RUN gcc -O2 -static -o /vpsagent /s/vpsagent.c $(pkg-config --static --cflags --libs libcurl)
FROM scratch
COPY --from=b /vpsagent /vpsagent
COPY --from=b /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
ENTRYPOINT ["/vpsagent"]
