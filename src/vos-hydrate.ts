// Shared VOS Sapphire detail-page hydration (worker side) — every state
// EXCEPT Georgia.
//
// WHY THIS EXISTS
// Firecrawl charges 1 credit per detail page. The eight-state footprint is
// hundreds of thousands of rows, so per-page pricing is a non-starter. Unlike
// Georgia, non-GA VOS `enc=` detail tokens are NOT session-bound, so one
// Bright Data browser session can walk thousands of detail pages back to back
// — cost becomes per-minute instead of per-page.
//
// DESIGN
// - State config (host, path prefix) arrives from the APP, so adding a state
//   never requires a worker redeploy.
// - The worker does NOT parse fields. It returns rendered page text plus the
//   outbound links it saw, and the app's `parseVosDetail` does extraction, so
//   there is exactly one parser and parser fixes ship without a redeploy.
// - Bounce detection: a VOS portal answers HTTP 200 with the SEARCH page when
//   a detail token is rejected. We flag that explicitly instead of letting the
//   app parse a search page into garbage.
// - GEORGIA IS UNTOUCHED: hydrate.ts and worksourcega.ts are not imported.

import puppeteer, { type Browser, type Page } from "puppeteer-core";

export const VOS_HYDRATE_WORKER_VERSION = "vos-hydrate-v1.0-2026-08-09";

const NAV_TIMEOUT_MS = 45_000;
const MAX_URLS = 200;
const DEFAULT_BUDGET_MS = 480_000;
const HARD_BUDGET_MS = 870_000;

export type VosHydratePage = {
  url: string;
  ok: boolean;
  /** Rendered page text, newline-separated. Parsed app-side. */
  text?: string;
  /** Absolute outbound (non-portal) links found on the page, in DOM order. */
  outboundLinks?: string[];
  pageTitle?: string;
  finalUrl?: string;
  /** True when the portal silently served the search page instead of detail. */
  bounced?: boolean;
  error?: string;
};

export type VosHydrateInput = {
  host: string;
  pathPrefix?: string;
  urls: string[];
  budgetMs?: number;
};

export type VosHydrateResult = {
  workerVersion: string;
  status: "ok" | "error";
  requested: number;
  fetched: number;
  failed: number;
  bounced: number;
  hitTimeBudget: boolean;
  elapsedMs: number;
  pages: VosHydratePage[];
  diagnostic?: string;
  error?: string;
};

function log(lines: string[], message: string) {
  lines.push(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

/** The VOS search page is unmistakable; a detail page never carries these. */
function looksLikeSearchPage(text: string, title: string): boolean {
  const haystack = `${title}\n${text.slice(0, 1500)}`.toLowerCase();
  return (
    /standard job search|job search results|refine your search|we have found\s+[\d,]+\s+job/.test(haystack) &&
    !/job order id|job\s*#|job description/i.test(text.slice(0, 4000))
  );
}

async function readDetailPage(page: Page, url: string, host: string): Promise<VosHydratePage> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForNetworkIdle({ timeout: 6_000 }).catch(() => null);

    const extracted = await page.evaluate((portalHost: string) => {
      const text = (document.body?.innerText ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");

      const hostRe = new RegExp(portalHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const outboundLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
        .map((a) => a.href)
        .filter(
          (href) =>
            /^https?:\/\//i.test(href) &&
            !hostRe.test(href) &&
            !/^https?:\/\/(?:www\.)?(?:geosolinc\.com|adobe\.com|dol\.gov)/i.test(href),
        );

      return {
        text,
        outboundLinks: Array.from(new Set(outboundLinks)).slice(0, 25),
        pageTitle: document.title,
        currentUrl: window.location.href,
      };
    }, host);

    const bounced = looksLikeSearchPage(extracted.text, extracted.pageTitle);

    return {
      url,
      ok: !bounced,
      text: extracted.text,
      outboundLinks: extracted.outboundLinks,
      pageTitle: extracted.pageTitle,
      finalUrl: extracted.currentUrl,
      bounced,
      ...(bounced ? { error: "bounced to portal search page" } : {}),
    };
  } catch (e) {
    return { url, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runVosHydrate(input: VosHydrateInput): Promise<VosHydrateResult> {
  const startedAt = Date.now();
  const diag: string[] = [];
  const urls = (input.urls ?? [])
    .map((u) => (u ?? "").trim())
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, MAX_URLS);
  const budgetMs = Math.max(
    30_000,
    Math.min(HARD_BUDGET_MS, Number(input.budgetMs) > 0 ? Number(input.budgetMs) : DEFAULT_BUDGET_MS),
  );

  log(diag, `${VOS_HYDRATE_WORKER_VERSION} — ${input.host} ${urls.length} detail urls, budget ${Math.round(budgetMs / 1000)}s`);

  const fail = (error: string): VosHydrateResult => ({
    workerVersion: VOS_HYDRATE_WORKER_VERSION,
    status: "error",
    requested: urls.length,
    fetched: 0,
    failed: urls.length,
    bounced: 0,
    hitTimeBudget: false,
    elapsedMs: Date.now() - startedAt,
    pages: [],
    diagnostic: diag.join("\n"),
    error,
  });

  if (urls.length === 0) return fail("no urls supplied");
  const wss = process.env.BRIGHTDATA_SCRAPING_BROWSER_WSS;
  if (!wss) return fail("BRIGHTDATA_SCRAPING_BROWSER_WSS not configured");

  let browser: Browser | undefined;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: wss });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    // Seed a guest session once. Non-GA tokens are not session-bound, but the
    // landing sets the culture/state cookies the portal expects, and doing it
    // once per batch costs a single navigation.
    const prefix = (input.pathPrefix ?? "").replace(/\/$/, "");
    await page
      .goto(`https://${input.host}${prefix}/vosnet/Guest.aspx?guesttype=IND`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      })
      .catch((e: unknown) => log(diag, `guest landing skipped: ${(e as Error).message}`));

    const pages: VosHydratePage[] = [];
    let hitTimeBudget = false;
    for (const url of urls) {
      if (Date.now() - startedAt > budgetMs) {
        hitTimeBudget = true;
        log(diag, `time budget reached after ${pages.length} pages`);
        break;
      }
      pages.push(await readDetailPage(page, url, input.host));
    }

    const fetched = pages.filter((p) => p.ok).length;
    const bounced = pages.filter((p) => p.bounced).length;
    log(diag, `fetched ${fetched}/${pages.length} (bounced ${bounced})`);

    return {
      workerVersion: VOS_HYDRATE_WORKER_VERSION,
      status: "ok",
      requested: urls.length,
      fetched,
      failed: pages.length - fetched,
      bounced,
      hitTimeBudget,
      elapsedMs: Date.now() - startedAt,
      pages,
      diagnostic: diag.join("\n"),
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    await browser?.close().catch(() => null);
  }
}
