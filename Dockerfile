# panya server image. Debian base (not Alpine): onnxruntime needs glibc.
FROM oven/bun:1.3 AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    PANYA_HOST=0.0.0.0 \
    PANYA_PORT=6800 \
    PANYA_EMBED_MODEL=Xenova/multilingual-e5-small \
    PANYA_EMBED_DIM=384

# Bake the embedding model into the image so the container never needs to
# reach Hugging Face at start-up (a cold start on a locked-down host would hang).
RUN bun -e "import('./src/embed.ts').then(async (m) => { await m.warmup(); const v = await m.localEmbedder.query('warmup'); if (v.length !== 384) throw new Error('unexpected dimension ' + v.length); console.log('model cached, dim', v.length) })"

EXPOSE 6800
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:6800/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "src/index.ts"]
