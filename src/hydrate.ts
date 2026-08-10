/**
 * WorkSource Georgia detail-page hydration (worker side).
 *
 * The portal's `jobdetails.aspx?enc=<token>` links are bound to a signed-in
 * portal session. An anonymous fetch does NOT 403 — it silently serves the
 * Standard Job Search page, which is why the Firecrawl-based probe produced a
 * false positive. The only reliable transport is this worker: it seeds a real
 * guest session in the Bright Data browser and then navigates to each detail
 * URL inside that same session.
 *
 * The worker deliberately does NOT parse fields. It returns the rendered text
 * of each detail page plus the outbound links it found, and the app-side
 * parser (`parseDetailMarkdown` / `isJobDetailPage`) does the extraction, so
 * both transports share one tested implementation.
 */

import puppeteer, { type Browser, type Page } from "puppeteer-core";

export const WORKSOURCE_HYDRATE_WORKER_VERSION = "v6.0-detail-hydration-2026-08-03";

const BASE_URL = "https://www.worksourcegaportal.com";
const NAV_TIMEOUT_MS = 45_000;
/** Hard ceiling per request so a batch can never outlive the caller's budget. */
const MAX_URLS = 40;

export type HydratePageResult = {
  url: string;
  ok: boolean;
  /** Rendered page text, newline-separated. Parsed app-side. */
  text?: string;
  /** Absolute outbound (non-portal) links found on the page, in DOM order. */
  outboundLinks?: string[];
  pageTitle?: string;
  finalUrl?: string;
  error?: string;
};

export type HydrateResult = {
  workerVersion: string;
  status: "ok" | "error";
  requested: number;
  fetched: number;
  failed: number;
  elapsedMs: number;
  pages: HydratePageResult[];
  diagnostic?: string;
  error?: string;
};

function log(lines: string[], message: string) {
  lines.push(`[${new Date().toISOString()}] ${message}`);
}

async function readDetailPage(page: Page, url: string): Promise<HydratePageResult> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForNetworkIdle({ timeout: 8_000 }).catch(() => null);

    const extracted = await page.evaluate(() => {
      const text = (document.body?.innerText ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n");

      const outboundLinks = Array.from(
        document.querySelectorAll<HTMLAnchorElement>("a[href]"),
      )
        .map((a) => a.href)
        .filter(
          (href) =>
            /^https?:\/\//i.test(href) &&
            !/worksourcegaportal\.com/i.test(href) &&
            !/^https?:\/\/(?:www\.)?(?:geosolinc\.com|adobe\.com)/i.test(href),
        );

      return {
        text,
        outboundLinks: Array.from(new Set(outboundLinks)).slice(0, 20),
        pageTitle: document.title,
        currentUrl: window.location.href,
      };
    });

    return {
      url,
      ok: true,
      text: extracted.text,
      outboundLinks: extracted.outboundLinks,
      pageTitle: extracted.pageTitle,
      finalUrl: extracted.currentUrl,
    };
  } catch (e) {
    return { url, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runWorksourceHydrate(
  opts: { urls?: string[] } = {},
): Promise<HydrateResult> {
  const startedAt = Date.now();
  const diag: string[] = [];
  const urls = (opts.urls ?? [])
    .map((u) => (u ?? "").trim())
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, MAX_URLS);

  log(diag, `${WORKSOURCE_HYDRATE_WORKER_VERSION} — ${urls.length} detail urls`);

  const fail = (error: string): HydrateResult => ({
    workerVersion: WORKSOURCE_HYDRATE_WORKER_VERSION,
    status: "error",
    requested: urls.length,
    fetched: 0,
    failed: urls.length,
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

    // Seed the guest session FIRST. Detail `enc=` tokens only resolve inside a
    // live portal session; without this every navigation bounces to search.
    await page.goto(`${BASE_URL}/vosnet/Guest.aspx?guesttype=IND`, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    log(diag, `guest session seeded: ${page.url()}`);

    const pages: HydratePageResult[] = [];
    for (const url of urls) {
      const result = await readDetailPage(page, url);
      pages.push(result);
    }

    const fetched = pages.filter((p) => p.ok).length;
    log(diag, `fetched ${fetched}/${urls.length}`);

    return {
      workerVersion: WORKSOURCE_HYDRATE_WORKER_VERSION,
      status: "ok",
      requested: urls.length,
      fetched,
      failed: urls.length - fetched,
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
