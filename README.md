# INNOPRO Super Agent

Knowledge-first digital workforce platform. Enterprises connect their documents and systems; the super agent
recommends digital employees and tools; work is assigned in a chat command room or triggered by dates and email;
anything a human must decide lands in "My work" with evidence, approval and read-back.

Spec: [`docs/prd/super-agent-prd.md`](docs/prd/super-agent-prd.md) (PRD v1.3). Ownership: [`docs/OWNERSHIP.md`](docs/OWNERSHIP.md).

## Layout

```
apps/server     Fastify API + worker (one image, APP_ROLE=web|worker)
apps/web        React + Vite workbench (built and served by the server)
packages/shared Shared contracts: roles, LLM provider, knowledge plugins, tools, work items
infra/          Azure Bicep (Container Apps, PostgreSQL, Blob, Key Vault, Document Intelligence, ...)
```

## Develop

Requires Node 22.9 or later. PostgreSQL 16 is optional: with `AUTH_MODE=dev` (the default in `.env.example`) the
server keeps everything in memory, so data is lost on restart and the PostgreSQL tests are skipped.

```bash
npm install
cp .env.example .env
npm run build -w @superagent/shared
npm run dev:server   # http://localhost:8080
npm run dev:web      # http://localhost:5173 (proxies /api, /auth and /healthz to the server)
npm test
```

Both dev commands read the `.env` at the repository root. Run them from the root, each in its own terminal.
`test/sandbox-isolation.test.ts` needs `infra/main.json`; create it with
`az bicep build --file infra/main.bicep --outfile infra/main.json` (CI does this), otherwise that one file fails.

## Run as a container

```bash
docker build -t superagent .
docker run -p 8080:8080 -e APP_ROLE=web superagent
docker run -e APP_ROLE=worker -e DATABASE_URL=... superagent
```

In Azure, the worker runs as its own Container App with `minReplicas >= 1`. Secrets (model API key, connector
credentials) live only in Key Vault and are read through managed identity — never in env files, images, or the database.
