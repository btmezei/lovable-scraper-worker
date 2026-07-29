import express from "express";
import { z } from "zod";
import { runWorksourceGa, WORKSOURCE_GA_WORKER_VERSION } from "./worksourcega.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.SCRAPER_TOKEN;

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, workerVersion: WORKSOURCE_GA_WORKER_VERSION, ts: new Date().toISOString() });
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

app.listen(PORT, () => {
  console.log(`[scraper] listening on :${PORT}`);
});
