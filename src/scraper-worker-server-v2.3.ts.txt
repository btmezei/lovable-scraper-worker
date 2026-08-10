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
// for the result.
//
// 2026-08-10: deep 60-page slices were coming back `unknown_job` after ~6
// minutes. Two causes, both fixed here:
//   1. The in-memory map is lost whenever the Render process restarts (OOM on
//      big HTML payloads, deploy, idle recycle). Job state is now mirrored to
//      disk so a restarted process can still answer the poll.
//   2. A caller could not tell "job never existed" from "job was reaped". The
//      poll now reports progress heartbeats while running, so a silent stall is
//      visible instead of looking like a vanished job.
import fs from "node:fs";
import path from "node:path";

type JobState = {
  id: string;
  kind: string;
  status: "running" | "done" | "error";
  startedAt: string;
  updatedAt: string;
  /** Last heartbeat from the runner: pages walked so far + what it just did. */
  progress?: { pagesWalked: number; note: string; at: string };
  finishedAt?: string;
  result?: unknown;
  error?: string;
};
const JOBS = new Map<string, JobState>();
const JOB_TTL_MS = 3 * 60 * 60 * 1000;
const JOB_DIR = path.join("/tmp", "scraper-jobs");

try {
  fs.mkdirSync(JOB_DIR, { recursive: true });
} catch {
  /* disk mirror is best-effort */
}

function jobPath(id: string) {
  return path.join(JOB_DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, "")}.json`);
}

function persist(job: JobState) {
  try {
    fs.writeFileSync(jobPath(job.id), JSON.stringify(job));
  } catch {
    /* best-effort */
  }
}

function loadFromDisk(id: string): JobState | null {
  try {
    return JSON.parse(fs.readFileSync(jobPath(id), "utf8")) as JobState;
  } catch {
    return null;
  }
}

function reapJobs() {
  const now = Date.now();
  for (const [id, j] of JOBS) {
    if (j.finishedAt && now - new Date(j.finishedAt).getTime() > JOB_TTL_MS) {
      JOBS.delete(id);
      try {
        fs.unlinkSync(jobPath(id));
      } catch {
        /* already gone */
      }
    }
  }
}

function startJob(
  kind: string,
  work: (onProgress: (p: { pagesWalked: number; note: string }) => void) => Promise<unknown>,
): JobState {
  reapJobs();
  const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const job: JobState = { id, kind, status: "running", startedAt: now, updatedAt: now };
  JOBS.set(id, job);
  persist(job);

  const onProgress = (p: { pagesWalked: number; note: string }) => {
    job.progress = { ...p, at: new Date().toISOString() };
    job.updatedAt = job.progress.at;
    persist(job);
  };

  void work(onProgress)
    .then((result) => {
      job.status = "done";
      job.result = result;
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      persist(job);
    })
    .catch((e: unknown) => {
      job.status = "error";
      job.error = e instanceof Error ? e.message : String(e);
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      persist(job);
    });
  return job;
}

app.post("/jobs/vos", (req, res) => {
  const parsed = vosInput.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
  }
  const job = startJob("vos", (onProgress) => runVosWorker(parsed.data, { onProgress }));
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
  const job = JOBS.get(req.params.id) ?? loadFromDisk(req.params.id);
  if (!job) return res.status(404).json({ error: "unknown_job" });
  // A disk-recovered "running" job whose process died can never finish; say so
  // instead of leaving the caller polling a ghost.
  if (!JOBS.has(req.params.id) && job.status === "running") {
    return res.json({
      ...job,
      status: "error",
      error: `worker process restarted mid-run (last heartbeat ${job.updatedAt})`,
    });
  }
  res.json(job);
});


app.listen(PORT, () => {
  console.log(`[scraper] listening on :${PORT}`);
});
