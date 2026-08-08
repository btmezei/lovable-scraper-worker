import express from "express";
import { z } from "zod";
import { runWorksourceGa, WORKSOURCE_GA_WORKER_VERSION } from "./worksourcega.js";
import { runWorksourceHydrate, WORKSOURCE_HYDRATE_WORKER_VERSION } from "./hydrate.js";
import { runScWorks, SCWORKS_WORKER_VERSION } from "./scworks.js";
import { runVosWorker, VOS_WORKER_VERSION } from "./vos.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.SCRAPER_TOKEN;

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    workerVersion: WORKSOURCE_GA_WORKER_VERSION,
    hydrateVersion: WORKSOURCE_HYDRATE_WORKER_VERSION,
    scworksVersion: SCWORKS_WORKER_VERSION,
    vosVersion: VOS_WORKER_VERSION,
    ts: new Date().toISOString(),
  });
});


app.use((req, res, next) => {
  if (req.path === "/healthz") return next();
  const auth = req.header("authorization") ?? "";
  if (!TOKEN || auth !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

const worksourceInput = z.object({
  zip: z.string().optional(),
  radius: z.string().optional(),
  resultsUrl: z.string().url().optional(),
  portalCookie: z.string().optional(),
  maxPages: z.number().int().min(1).max(40).optional(),
});


app.post("/scrape/worksourcega", async (req, res) => {
  const parsed = worksourceInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
  }
  try {
    const result = await runWorksourceGa(parsed.data);

    res.json(result);
  } catch (e) {
    res.status(500).json({
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

const hydrateInput = z.object({
  urls: z.array(z.string().url()).min(1).max(40),
});

// Detail-page hydration. Runs inside a seeded guest session so `enc=` tokens
// resolve instead of bouncing to the Standard Job Search page.
app.post("/hydrate/worksourcega", async (req, res) => {
  const parsed = hydrateInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
  }
  try {
    const result = await runWorksourceHydrate(parsed.data);
    res.json(result);
  } catch (e) {
    res.status(500).json({
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

// --- South Carolina pilot ------------------------------------------------
// Separate handler backed by scworks.ts. Nothing above this line changed
// behaviourally, so the Georgia routes are byte-identical in behaviour.
const scworksInput = z.object({
  keyword: z.string().max(60).optional(),
  resultsUrl: z.string().url().optional(),
  portalCookie: z.string().optional(),
  maxPages: z.number().int().min(1).max(40).optional(),
});

app.post("/scrape/scworks", async (req, res) => {
  const parsed = scworksInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
  }
  try {
    const result = await runScWorks(parsed.data);
    res.json(result);
  } catch (e) {
    res.status(500).json({
      status: "error",
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

// --- Shared VOS deep pager (all non-Georgia states) -----------------------
// State config arrives from the app, so new states never need a redeploy.
const vosInput = z.object({
  host: z.string().min(3).max(120),
  pathPrefix: z.string().max(60).optional(),
  keyword: z.string().max(80),
  zip: z.string().min(3).max(10),
  radius: z.number().int().min(5).max(250).optional(),
  maxPages: z.number().int().min(1).max(60).optional(),
  budgetMs: z.number().int().min(30_000).max(870_000).optional(),
  excludeSources: z.array(z.string().max(60)).max(20).optional(),
});

app.post("/scrape/vos", async (req, res) => {
  const parsed = vosInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
  }
  try {
    res.json(await runVosWorker(parsed.data));
  } catch (e) {
    res.status(500).json({ status: "error", error: e instanceof Error ? e.message : String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`[scraper] listening on :${PORT}`);
});

