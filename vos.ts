// Shared VOS Sapphire deep-pagination runner (every state EXCEPT Georgia).
//
// WHY THIS EXISTS
// Anonymous Firecrawl sweeps top out at ~4 pages per query: the connector
// gateway kills the request around 60s of postback chaining, and every VOS
// pager step costs several seconds. The ceiling census measured ~229k SC
// postings sitting past that reach across the 148-keyword pool. A persistent
// browser session on Render has no 60s ceiling, so it can walk the pager until
// the portal actually runs out of pages.
//
// DESIGN
// - Config comes from the APP in the request body (host, path prefix, anchor
//   zip, radius). The worker stays state-agnostic so adding a state never
//   requires a worker deploy.
// - It returns RAW per-page HTML fragments, not parsed cards. The app already
//   owns `parseVosCards`; sending HTML back keeps exactly one parser in the
//   codebase and means parser fixes ship without redeploying Render.
// - GEORGIA IS UNTOUCHED. worksourcega.ts and hydrate.ts are not imported
//   here and nothing in this file can change their behaviour.

import puppeteer, { type Browser, type Page } from "puppeteer-core";

export const VOS_WORKER_VERSION = "vos-worker-v1.1-deep-pager-source-filter-2026-08-08";

const NAV_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_PAGES = 10;
const HARD_MAX_PAGES = 60;
/** Render requests can run long; the app passes its own budget per call. */
const DEFAULT_BUDGET_MS = 240_000;
const HARD_BUDGET_MS = 870_000;
const GRID_WAIT_MS = 15_000;

export type VosWorkerInput = {
  host: string;
  pathPrefix?: string;
  keyword: string;
  zip: string;
  radius?: number;
  maxPages?: number;
  budgetMs?: number;
  /**
   * Source-channel labels to UNCHECK on the portal's own filter before paging.
   * Upstream suppression: we never pay Bright Data to walk pages of NLX/PJB
   * re-posts. Labels come from the app so rule changes need no redeploy.
   */
  excludeSources?: string[];
};

export type VosWorkerResult = {
  workerVersion: string;
  status: "ok" | "error";
  /** One entry per page walked, in order. Raw card-grid HTML for the app parser. */
  pagesHtml: string[];
  pagesWalked: number;
  hitPageCap: boolean;
  hitTimeBudget: boolean;
  maxPages: number;
  /** The portal's own "we have found N jobs" banner text, page 1. */
  totalText: string | null;
  /** Source-filter labels actually unchecked on this run. */
  sourcesUnchecked: string[];
  diagnostic: string;
  error?: string;
};

const CARD_ANCHOR_SEL = 'a[id^="lnkJobOrderTitle_"], a[href*="jobdetail" i], a[id*="lnkTitle" i]';

function log(lines: string[], message: string) {
  lines.push(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function errResult(diag: string[], error: string, maxPages = 0): VosWorkerResult {
  return {
    workerVersion: VOS_WORKER_VERSION,
    status: "error",
    pagesHtml: [],
    pagesWalked: 0,
    hitPageCap: false,
    hitTimeBudget: false,
    maxPages,
    totalText: null,
    sourcesUnchecked: [],
    diagnostic: diag.join(" | "),
    error,
  };
}

function buildSearchUrl(input: VosWorkerInput): string {
  const radius = String(input.radius ?? 100);
  const params = new URLSearchParams({
    origin: "qsb",
    session: "jobsearch",
    t: "h",
    keyword: input.keyword,
    zip: input.zip,
    distance: radius,
    location: input.zip,
    radius,
    ff_requery: "1",
    ff_statereload: "0",
    ff_keyword_option: "1, 2",
  });
  const prefix = (input.pathPrefix ?? "").replace(/\/$/, "");
  return `https://${input.host}${prefix}/vosnet/jobbanks/joblist.aspx?${params.toString()}`;
}

export async function runVosWorker(input: VosWorkerInput): Promise<VosWorkerResult> {
  const wss = process.env.BRIGHTDATA_SCRAPING_BROWSER_WSS;
  const startedAt = Date.now();
  const maxPages = Math.max(
    1,
    Math.min(HARD_MAX_PAGES, Number(input.maxPages) > 0 ? Number(input.maxPages) : DEFAULT_MAX_PAGES),
  );
  const budgetMs = Math.max(
    30_000,
    Math.min(HARD_BUDGET_MS, Number(input.budgetMs) > 0 ? Number(input.budgetMs) : DEFAULT_BUDGET_MS),
  );

  const diag: string[] = [];
  log(diag, `${VOS_WORKER_VERSION} — ${input.host} kw="${input.keyword}" zip=${input.zip} cap ${maxPages}p budget ${Math.round(budgetMs / 1000)}s`);
  if (!wss) return errResult(diag, "BRIGHTDATA_SCRAPING_BROWSER_WSS not configured", maxPages);

  let browser: Browser | undefined;
  let page: Page | undefined;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: wss });
    log(diag, "connected to Bright Data");

    page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    const prefix = (input.pathPrefix ?? "").replace(/\/$/, "");
    await page
      .goto(`https://${input.host}${prefix}/vosnet/Guest.aspx?guesttype=IND`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      })
      .catch((e: unknown) => log(diag, `guest landing skipped: ${(e as Error).message}`));

    await page.goto(buildSearchUrl(input), { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    log(diag, `landed url=${page.url()}`);

    await page.waitForNetworkIdle({ timeout: 20_000 }).catch(() => null);
    await page
      .waitForFunction((sel) => !!document.querySelector(sel as string), { timeout: 45_000 }, CARD_ANCHOR_SEL)
      .then(() => log(diag, "cards present"))
      .catch((e: unknown) => log(diag, `no cards appeared: ${(e as Error).message}`));

    const active: Page = page;

    const remainingMs = () => Math.max(0, budgetMs - (Date.now() - startedAt));
    const hasBudget = () => remainingMs() > 8_000;

    /** Cheap signature of the current grid; used to detect a real pager step. */
    const fingerprint = async (): Promise<string> =>
      await active.evaluate((sel) => {
        const a = document.querySelectorAll<HTMLAnchorElement>(sel as string);
        return `${a.length}|${a[0]?.getAttribute("href") ?? ""}|${a[a.length - 1]?.getAttribute("href") ?? ""}`;
      }, CARD_ANCHOR_SEL);

    const waitForGridChange = async (before: string): Promise<boolean> => {
      const deadline = Date.now() + Math.min(GRID_WAIT_MS, remainingMs());
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        if ((await fingerprint()) !== before) {
          await new Promise((r) => setTimeout(r, 700));
          return true;
        }
      }
      return false;
    };

    /** Grab just the card grid when we can find it; the whole body otherwise. */
    const grabHtml = async (): Promise<string> =>
      await active.evaluate(() => {
        const container =
          document.querySelector('[id*="CardList"]') ??
          document.querySelector("#ctl00_Main_content_JobSearch") ??
          document.body;
        return container.innerHTML;
      });

    // --- Upstream suppression -------------------------------------------
    // Uncheck the junk source channels BEFORE walking the pager. Every page we
    // avoid here is a page we never pay for. Matching is label-substring based
    // and case-insensitive; a label that is not present is simply skipped.
    const sourcesUnchecked: string[] = [];
    const wanted = (input.excludeSources ?? []).filter((s) => s.trim().length > 1);
    if (wanted.length > 0) {
      const fpBefore = await fingerprint();
      const hits = await active.evaluate((labels: string[]) => {
        const lowered = labels.map((l) => l.toLowerCase());
        const done: string[] = [];
        const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
        for (const box of boxes) {
          if (!box.checked) continue;
          const label =
            (box.closest("label")?.textContent ??
              document.querySelector(`label[for="${box.id}"]`)?.textContent ??
              box.parentElement?.textContent ??
              "").replace(/\s+/g, " ").trim();
          if (!label) continue;
          const lower = label.toLowerCase();
          if (!lowered.some((l) => lower.includes(l))) continue;
          box.click();
          done.push(label.slice(0, 60));
        }
        return done;
      }, wanted);
      if (hits.length > 0) {
        sourcesUnchecked.push(...hits);
        // Re-run the search so the filter takes effect on the result set.
        await active
          .evaluate(() => {
            const btn = document.querySelector<HTMLElement>(
              '[id*="btnSearch" i], [id*="btnFilter" i], input[type="submit"][value*="Search" i]',
            );
            btn?.click();
          })
          .catch(() => null);
        await waitForGridChange(fpBefore);
        log(diag, `unchecked sources: ${hits.join(", ")}`);
      } else {
        log(diag, "no matching source checkboxes found (filter panel absent)");
      }
    }

    // Bump the page-length dropdown to 100 so each pager step is worth 100 cards.
    for (const size of ["100", "50"]) {
      const fp = await fingerprint();
      const clicked = await active.evaluate((sz) => {
        const items = Array.from(
          document.querySelectorAll<HTMLElement>("div.CardListPagerDD a.dropdown-item, a.dropdown-item, a, span[role='button']"),
        );
        const target = items.find((el) => (el.textContent ?? "").trim() === sz);
        if (!target) return false;
        target.click();
        return true;
      }, size);
      if (clicked && (await waitForGridChange(fp))) {
        log(diag, `page size -> ${size}`);
        break;
      }
    }

    const pagesHtml: string[] = [await grabHtml()];
    let currentPage = 1;
    let hitTimeBudget = false;

    for (let p = 2; p <= maxPages; p++) {
      if (!hasBudget()) {
        hitTimeBudget = true;
        log(diag, `budget spent before page ${p}`);
        break;
      }
      const fp = await fingerprint();
      const advanced = await active.evaluate((want: number) => {
        const next = document.querySelector<HTMLElement>('[id^="nextPage"], a[id*="nextPage" i]');
        if (next) {
          next.click();
          return "next-id";
        }
        const clickable = Array.from(
          document.querySelectorAll<HTMLElement>("a, li > a, span[role='button'], button"),
        );
        const numbered = clickable.find((el) => (el.textContent ?? "").trim() === String(want));
        if (numbered) {
          numbered.click();
          return `num-${want}`;
        }
        const textNext = clickable.find((el) => {
          const t = (el.textContent ?? "").trim().toLowerCase();
          return t === "next" || t === ">" || t === "»" || t === "›";
        });
        if (textNext) {
          textNext.click();
          return "next-text";
        }
        return null;
      }, currentPage + 1);

      if (!advanced) {
        log(diag, `no next control at page ${p} — pager exhausted`);
        break;
      }
      if (!(await waitForGridChange(fp))) {
        log(diag, `grid did not refresh after ${advanced} at page ${p} — stopping`);
        break;
      }
      currentPage = p;
      pagesHtml.push(await grabHtml());
    }

    const totalText = await active.evaluate(() => {
      const el = Array.from(document.querySelectorAll<HTMLElement>("div, span, h1, h2, p")).find((n) =>
        /we have found|jobs? (?:were )?found|results? found/i.test(n.textContent ?? ""),
      );
      return el?.textContent?.replace(/\s+/g, " ").trim().slice(0, 200) ?? null;
    });

    log(diag, `walked ${currentPage} pages, ${pagesHtml.length} html blobs, total="${totalText ?? "?"}"`);

    await page.close().catch(() => null);
    page = undefined;
    browser.disconnect();
    browser = undefined;

    return {
      workerVersion: VOS_WORKER_VERSION,
      status: "ok",
      pagesHtml,
      pagesWalked: currentPage,
      hitPageCap: currentPage >= maxPages,
      hitTimeBudget,
      maxPages,
      totalText,
      sourcesUnchecked,
      diagnostic: diag.join(" | "),
    };
  } catch (e) {
    if (page) await page.close().catch(() => null);
    if (browser) {
      try {
        browser.disconnect();
      } catch {
        /* ignore */
      }
    }
    return errResult(diag, e instanceof Error ? e.message : String(e), maxPages);
  }
}
