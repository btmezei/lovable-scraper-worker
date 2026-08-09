# Lovable Scraper Worker

Small Node service that hosts CDP-driven scrapers (Bright Data Scraping Browser)
for sites the Cloudflare Worker runtime can't reach directly (no raw TCP/WS).

## Endpoints

All routes require `Authorization: Bearer $SCRAPER_TOKEN`.

- `GET /healthz` — returns `{ ok: true }`, no auth
- `POST /scrape/worksourcega` — body `{ zip?: string, radius?: string }`,
  returns the same `WorksourceGaChunkResult` shape the Lovable adapter used to
  produce locally.

## Env vars

- `SCRAPER_TOKEN` — shared secret; also set as a Lovable Cloud secret.
- `BRIGHTDATA_SCRAPING_BROWSER_WSS` — the `wss://` endpoint from Bright Data.
- `PORT` — provided by the host (Render sets this).

## Deploy on Render

1. Push this folder to a new GitHub repo (or use it as the deploy root of an
   existing repo).
2. New → Web Service → Docker → point at the repo.
3. Set the two env vars above. Health check `/healthz`.
4. Copy the public URL into the Lovable app as `SCRAPER_BASE_URL`, plus set
   `SCRAPER_TOKEN` there to the same value.

## Local dev

```
npm install
SCRAPER_TOKEN=dev BRIGHTDATA_SCRAPING_BROWSER_WSS=wss://... npm run dev
```

## Adding a new scraper

1. Add `src/<name>.ts` that exports `async function run(input): Promise<Result>`.
2. Wire it into `src/server.ts` under `/scrape/<name>` with a Zod validator.
3. Add a matching thin fetch adapter in the Lovable app under `src/lib/`.
