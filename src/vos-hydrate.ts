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

export const VOS_HYDRATE_WORKER_VERSION = "vos-hydrate-v1.3-apply-resolve-2026-08-09";

const NAV_TIMEOUT_MS = 20_000;
/**
 * v1.1 opened 8 tabs on ONE Bright Data session. Bright Data's Scraping
 * Browser is a single remote browser per session with a watchdog: concurrent
 * tabs tore the whole session down and every in-flight page died at once
 * ("Session closed" / "Target closed" on 88% of rows). v1.2 opens N INDEPENDENT
 * sessions with one tab each, pulling from a shared cursor, so a dead session
 * costs 1/N of throughput instead of the batch — and it reconnects itself.
 *
 * v1.3 adds APPLY RESOLUTION. The VOS detail page never contains the employer's
 * application URL as an href: the Apply control is an ASP.NET postback/JS hop
 * that only reveals the destination once clicked. So after reading the page we
 * click it and capture where the browser actually goes (popup or same-tab
 * navigation), then hand the resolved URL back to the app.
 */
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const MAX_URLS = 200;
const DEFAULT_BUDGET_MS = 480_000;
const HARD_BUDGET_MS = 870_000;
/** How many fresh sessions one lane may burn before it gives up. */
const MAX_RECONNECTS_PER_LANE = 4;
/** Extra wall clock spent per row on the Apply click. Keep it tight. */
const APPLY_CLICK_TIMEOUT_MS = 9_000;

/** Infra-level deaths: the row was never actually read, so it must be retried. */
function isTransportError(message: string): boolean {
  return /session closed|target closed|detached|websocket|connection closed|protocol error|net::ERR/i.test(
    message,
  );
}



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
  /** v1.3: destination the Apply control actually navigated to, if off-portal. */
  resolvedApplyUrl?: string;
  /** Why apply resolution produced nothing: no-button | portal-only | error text. */
  applyResolution?: string;
  error?: string;
};

export type VosHydrateInput = {
  host: string;
  pathPrefix?: string;
  urls: string[];
  budgetMs?: number;
  /** Parallel Bright Data sessions per batch. Defaults to 4, hard-capped at 8. */
  concurrency?: number;
  /** v1.3: click the Apply control and capture the destination. Default true. */
  resolveApply?: boolean;
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
  /** v1.3: how many rows produced an off-portal apply destination. */
  applyResolved?: number;
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

/**
 * v1.3 — resolve the real application destination.
 *
 * The Apply control on a VOS Sapphire detail page is not an href: it is either
 * an ASP.NET `__doPostBack` link or a JS shim that opens the employer site in a
 * popup. Reading the DOM therefore yields nothing. We click it and observe the
 * browser: a popup target, or a same-tab navigation away from the portal.
 *
 * Everything here is best-effort and time-boxed — a row that cannot be resolved
 * still keeps its parsed text/links, so we never trade data for the apply link.
 */
async function resolveApplyDestination(
  page: Page,
  host: string,
): Promise<{ resolvedApplyUrl?: string; applyResolution?: string }> {
  const hostRe = new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const isOffPortal = (u: string) =>
    /^https?:\/\//i.test(u) && !hostRe.test(u) && !/geosolinc\.com|about:blank/i.test(u);

  try {
    // Locate the Apply control. Exclude portal-internal actions ("Apply4Me" is
    // the state's own hosted application, "Apply Filter" is the search UI).
    const found = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>("a, button, input[type=button], input[type=submit]"),
      );
      const label = (el: HTMLElement) =>
        (el instanceof HTMLInputElement ? el.value : (el.innerText ?? el.textContent ?? "")).trim();
      const match = nodes.find((el) => {
        const t = label(el);
        if (!/\bapply\b/i.test(t)) return false;
        if (/apply\s*4\s*me|apply filter|applied|application history|reapply/i.test(t)) return false;
        return t.length <= 60 && el.offsetParent !== null;
      });
      if (!match) return null;
      match.setAttribute("data-vos-apply", "1");
      return { text: label(match) };
    });
    if (!found) return { applyResolution: "no-apply-control" };

    const popupPromise = new Promise<Page | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), APPLY_CLICK_TIMEOUT_MS);
      page.once("popup", (p) => {
        clearTimeout(timer);
        resolve(p ?? null);
      });
    });
    const navPromise = page
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: APPLY_CLICK_TIMEOUT_MS })
      .catch(() => null);

    await page.click("[data-vos-apply='1']").catch(() => null);
    const popup = await popupPromise;

    if (popup) {
      try {
        await popup
          .waitForNavigation({ waitUntil: "domcontentloaded", timeout: APPLY_CLICK_TIMEOUT_MS })
          .catch(() => null);
        const popupUrl = popup.url();
        await popup.close().catch(() => null);
        if (isOffPortal(popupUrl)) return { resolvedApplyUrl: popupUrl };
        return { applyResolution: "popup-stayed-on-portal" };
      } catch (e) {
        await popup.close().catch(() => null);
        return { applyResolution: `popup-error: ${(e as Error).message.slice(0, 60)}` };
      }
    }

    await navPromise;
    const afterUrl = page.url();
    if (isOffPortal(afterUrl)) return { resolvedApplyUrl: afterUrl };

    // Some states hop through an interstitial "you are leaving" page that holds
    // the real destination as the only outbound link.
    const interstitial = await page
      .evaluate((portalHost: string) => {
        const re = new RegExp(portalHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
          .map((a) => a.href)
          .filter((h) => /^https?:\/\//i.test(h) && !re.test(h) && !/geosolinc\.com/i.test(h));
        return links[0] ?? null;
      }, host)
      .catch(() => null);
    if (interstitial && /leaving|redirect|external/i.test(page.url())) {
      return { resolvedApplyUrl: interstitial };
    }
    return { applyResolution: "click-stayed-on-portal" };
  } catch (e) {
    return { applyResolution: `apply-click-error: ${(e as Error).message.slice(0, 80)}` };
  }
}

async function readDetailPage(
  page: Page,
  url: string,
  host: string,
  resolveApply: boolean,
): Promise<VosHydratePage> {

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForNetworkIdle({ timeout: 1_500 }).catch(() => null);

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

    // Only worth clicking on a real detail page.
    const apply =
      !bounced && resolveApply ? await resolveApplyDestination(page, host) : {};

    return {
      url,
      ok: !bounced,
      text: extracted.text,
      outboundLinks: extracted.outboundLinks,
      pageTitle: extracted.pageTitle,
      finalUrl: extracted.currentUrl,
      bounced,
      ...apply,
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

  const resolveApply = input.resolveApply !== false;
  log(
    diag,
    `${VOS_HYDRATE_WORKER_VERSION} — ${input.host} ${urls.length} detail urls, budget ${Math.round(budgetMs / 1000)}s, applyResolve ${resolveApply ? "on" : "off"}`,
  );

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

  const concurrency = Math.max(
    1,
    Math.min(
      MAX_CONCURRENCY,
      Math.floor(Number(input.concurrency) > 0 ? Number(input.concurrency) : DEFAULT_CONCURRENCY),
    ),
  );
  const prefix = (input.pathPrefix ?? "").replace(/\/$/, "");
  const guestUrl = `https://${input.host}${prefix}/vosnet/Guest.aspx?guesttype=IND`;

  const results: Array<VosHydratePage | undefined> = new Array(urls.length);
  let hitTimeBudget = false;
  let cursor = 0;
  let reconnects = 0;

  /** One lane = one independent Bright Data session with a single tab. */
  const lane = async (slot: number) => {
    let browser: Browser | undefined;
    let page: Page | undefined;
    let laneReconnects = 0;

    const open = async () => {
      await browser?.close().catch(() => null);
      browser = await puppeteer.connect({ browserWSEndpoint: wss });
      page = await browser.newPage();
      page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      page.setDefaultTimeout(NAV_TIMEOUT_MS);
      // Seed the guest cookies once per session; tokens aren't session-bound
      // but the portal expects the culture/state cookies this landing sets.
      await page
        .goto(guestUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS })
        .catch((e: unknown) => log(diag, `lane ${slot} guest landing skipped: ${(e as Error).message}`));
    };

    try {
      await open();
      while (true) {
        const index = cursor++;
        if (index >= urls.length) break;
        if (Date.now() - startedAt > budgetMs) {
          hitTimeBudget = true;
          cursor = urls.length;
          break;
        }
        const url = urls[index]!;
        let result = await readDetailPage(page!, url, input.host, resolveApply);

        // Infra death: the page was never actually read. Rebuild the session
        // and give this one URL a second chance rather than burning the row.
        if (!result.ok && result.error && isTransportError(result.error)) {
          if (laneReconnects < MAX_RECONNECTS_PER_LANE) {
            laneReconnects++;
            reconnects++;
            log(diag, `lane ${slot} reconnecting after: ${result.error.slice(0, 80)}`);
            try {
              await open();
              result = await readDetailPage(page!, url, input.host, resolveApply);
            } catch (e) {
              result = { url, ok: false, error: e instanceof Error ? e.message : String(e) };
            }
          }
        }
        results[index] = result;
      }
    } catch (e) {
      log(diag, `lane ${slot} aborted: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      await browser?.close().catch(() => null);
    }
  };

  log(diag, `hydrating with ${concurrency} parallel sessions (1 tab each)`);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, (_unused, slot) => lane(slot)),
  );

  const pages: VosHydratePage[] = results.filter((p): p is VosHydratePage => Boolean(p));
  if (hitTimeBudget) log(diag, `time budget reached after ${pages.length} pages`);

  const fetched = pages.filter((p) => p.ok).length;
  const bounced = pages.filter((p) => p.bounced).length;
  const applyResolved = pages.filter((p) => p.resolvedApplyUrl).length;
  log(
    diag,
    `fetched ${fetched}/${pages.length} (bounced ${bounced}, reconnects ${reconnects}, applyResolved ${applyResolved})`,
  );

  return {
    workerVersion: VOS_HYDRATE_WORKER_VERSION,
    status: "ok",
    requested: urls.length,
    fetched,
    failed: pages.length - fetched,
    bounced,
    applyResolved,
    hitTimeBudget,
    elapsedMs: Date.now() - startedAt,
    pages,
    diagnostic: diag.join("\n"),
  };
}

