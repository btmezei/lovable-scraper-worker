import express from "express";
import { z } from "zod";
import { runWorksourceGa, WORKSOURCE_GA_WORKER_VERSION } from "./worksourcega.js";
import { runWorksourceHydrate, WORKSOURCE_HYDRATE_WORKER_VERSION } from "./hydrate.js";
import { runScWorks, SCWORKS_WORKER_VERSION } from "./scworks.js";
import { runVosWorker, VOS_WORKER_VERSION } from "./vos.js";
import { runVosHydrate, VOS_HYDRATE_WORKER_VERSION } from "./vos-hydrate.js";

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
    vosHydrateVersion: VOS_HYDRATE_WORKER_VERSION,
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
  pagerDiag: z.boolean().optional(),
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

// Shared VOS detail hydration (every state EXCEPT Georgia). One browser
// session per batch; non-GA `enc=` tokens are not session-bound, so this is
// per-minute cost instead of Firecrawl's per-page credit.
const vosHydrateInput = z.object({
  host: z.string().min(3).max(120),
  pathPrefix: z.string().max(60).optional(),
  urls: z.array(z.string().url()).min(1).max(200),
  budgetMs: z.number().int().min(30_000).max(870_000).optional(),
  // Zod strips unknown keys, so these MUST be declared or the app's settings
  // silently fall back to worker defaults (that swallowed concurrency in v1.2).
  concurrency: z.number().int().min(1).max(8).optional(),
  resolveApply: z.boolean().optional(),
});


app.post("/hydrate/vos", async (req, res) => {
  const parsed = vosHydrateInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
  }
  try {
    res.json(await runVosHydrate(parsed.data));
  } catch (e) {
    res.status(500).json({ status: "error", error: e instanceof Error ? e.message : String(e) });
  }
});


// --- Async job API --------------------------------------------------------
// Long VOS runs (pager diagnostics, deep walks) exceed the app gateway's ~60s
// request ceiling. The app now STARTS a job, gets an id immediately, and polls
// for the result. Jobs live in memory; the worker is a single process.
type JobState = {
  id: string;
  kind: string;
  status: "running" | "done" | "error";
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
};
const JOBS = new Map<string, JobState>();
const JOB_TTL_MS = 30 * 60 * 1000;

function reapJobs() {
  const now = Date.now();
  for (const [id, j] of JOBS) {
    if (j.finishedAt && now - new Date(j.finishedAt).getTime() > JOB_TTL_MS) JOBS.delete(id);
  }
}

function startJob(kind: string, work: () => Promise<unknown>): JobState {
  reapJobs();
  const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job: JobState = { id, kind, status: "running", startedAt: new Date().toISOString() };
  JOBS.set(id, job);
  void work()
    .then((result) => {
      job.status = "done";
      job.result = result;
      job.finishedAt = new Date().toISOString();
    })
    .catch((e: unknown) => {
      job.status = "error";
      job.error = e instanceof Error ? e.message : String(e);
      job.finishedAt = new Date().toISOString();
    });
  return job;
}

app.post("/jobs/vos", (req, res) => {
  const parsed = vosInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
  }
  const job = startJob("vos", () => runVosWorker(parsed.data));
  res.status(202).json({ jobId: job.id, status: job.status, workerVersion: VOS_WORKER_VERSION });
});

app.post("/jobs/hydrate-vos", (req, res) => {
  const parsed = vosHydrateInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
  }
  const job = startJob("hydrate-vos", () => runVosHydrate(parsed.data));
  res.status(202).json({ jobId: job.id, status: job.status, workerVersion: VOS_HYDRATE_WORKER_VERSION });
});

app.get("/jobs/:id", (req, res) => {
  const job = JOBS.get(req.params.id);
  if (!job) return res.status(404).json({ error: "unknown_job" });
  res.json(job);
});

app.listen(PORT, () => {
  console.log(`[scraper] listening on :${PORT}`);
});

