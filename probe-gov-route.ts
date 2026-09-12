// One-shot probe: can our render transports open a .gov VOS portal now that
// the Bright Data .gov KYC gate is approved? Tries the normal render chain
// (smartproxy → Bright Data unlocker → Firecrawl) against one VOS search URL
// and reports which transport, if any, returned a real job grid.
import { createFileRoute } from "@tanstack/react-router";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const TARGETS: Record<string, string> = {
  md: "https://mwejobs.maryland.gov/vosnet/jobbanks/joblist.aspx?origin=qsb&session=jobsearch&t=h&keyword=warehouse&zip=21201&distance=50&location=21201&radius=50",
  va: "https://www.vawc.virginia.gov/vosnet/jobbanks/joblist.aspx?origin=qsb&session=jobsearch&t=h&keyword=warehouse&zip=23219&distance=50&location=23219&radius=50",
  tn: "https://jobs4tnwfs.tn.gov/vosnet/jobbanks/joblist.aspx?origin=qsb&session=jobsearch&t=h&keyword=warehouse&zip=37201&distance=50&location=37201&radius=50",
  mo: "https://app-jobs.mo.gov/vosnet/jobbanks/joblist.aspx?origin=qsb&session=jobsearch&t=h&keyword=warehouse&zip=63101&distance=50&location=63101&radius=50",
  ca: "https://www.caljobs.ca.gov/vosnet/jobbanks/joblist.aspx?origin=qsb&session=jobsearch&t=h&keyword=warehouse&zip=95814&distance=50&location=95814&radius=50",
};

export const Route = createFileRoute("/api/public/probe-gov")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const expected = process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["SUPABASE_ANON_KEY"] ?? "";
        const provided =
          request.headers.get("apikey") ??
          request.headers.get("authorization")?.replace(/^Bearer /i, "") ??
          "";
        if (!expected || provided !== expected) return json({ error: "unauthorized" }, 401);

        const state = (new URL(request.url).searchParams.get("state") ?? "md").toLowerCase();
        const url = TARGETS[state];
        if (!url) return json({ error: `unknown state; one of ${Object.keys(TARGETS).join(",")}` }, 400);

        const { fetchRendered, renderTransportName } = await import("@/lib/ats/render-fetch.server");
        const started = Date.now();
        const html = await fetchRendered(url);
        const lower = (html ?? "").toLowerCase();
        const blocked =
          lower.includes("incapsula") ||
          lower.includes("imperva") ||
          lower.includes("access denied") ||
          (lower.includes("government") && lower.includes("blocked"));
        const hasGrid = lower.includes("joblist") || lower.includes("job bank") || lower.includes("results");
        return json({
          state,
          transport: renderTransportName(),
          ok: Boolean(html) && !blocked && html!.length > 5000,
          blocked,
          hasGrid,
          bytes: html?.length ?? 0,
          ms: Date.now() - started,
          sample: html ? html.slice(0, 400) : null,
        });
      },
    },
  },
});
