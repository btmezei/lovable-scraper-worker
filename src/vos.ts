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
import { gzipSync } from "node:zlib";

export const VOS_WORKER_VERSION = "vos-worker-v2.6-gov-brightdata-2026-09-11";

// SCWorks' first paint through Bright Data regularly runs past 90s (measured
// 2026-08-10: every v2.1 slice died on the initial goto). 180s plus one retry
// costs nothing when the portal is fast and rescues the slow cold starts.
const NAV_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_PAGES = 10;
const HARD_MAX_PAGES = 60;
/** Render requests can run long; the app passes its own budget per call. */
const DEFAULT_BUDGET_MS = 240_000;
const HARD_BUDGET_MS = 870_000;
const GRID_WAIT_MS = 15_000;

// ---------------------------------------------------------------------------
// Transport selection
//
// Bright Data refuses any host it classifies as Government, which knocks out
// CalJOBS and the VA/MD/MO/TN portals no matter which Bright Data product is
// used (verified again 2026-09-06: Web Unlocker AND Scraping Browser both
// answer "classified as Government and blocked"). Those portals also sit
// behind Imperva, which 403s a bare datacenter IP, so the only lane left is a
// real Chromium in this container pointed at an ordinary residential proxy.
//
// VOS_PROXY_URL takes a full proxy URL, e.g.
//   http://user:pass@gate.provider.com:7000
// Credentials are stripped out of the Chromium flag and applied per page with
// page.authenticate(), because Chromium ignores userinfo in --proxy-server.
// ---------------------------------------------------------------------------

const CHROME_PATH = process.env.CHROME_PATH || "/usr/bin/chromium";

type ProxyParts = { server: string; username?: string; password?: string };

function parseProxy(): ProxyParts | null {
  const raw = process.env.VOS_PROXY_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const server = `${u.protocol}//${u.host}`;
    return {
      server,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch {
    return null;
  }
}

export function proxyConfigured(): boolean {
  return parseProxy() !== null;
}

/** True for hosts Bright Data will not serve — those must use the proxy lane. */
function isGovHost(host: string): boolean {
  return /\.gov$/i.test(host.replace(/:\d+$/, ""));
}

async function applyProxyAuth(page: Page): Promise<void> {
  const proxy = parseProxy();
  if (proxy?.username) {
    await page
      .authenticate({ username: proxy.username, password: proxy.password ?? "" })
      .catch(() => undefined);
  }
}

async function openBrowser(
  host: string,
  diag: string[],
): Promise<{ browser: Browser; launched: boolean }> {
  const proxy = parseProxy();
  const wss = process.env.BRIGHTDATA_SCRAPING_BROWSER_WSS;

  // 2026-09-11: Bright Data approved .gov access (KYC cleared), so .gov hosts
  // go through the Scraping Browser like everything else. The residential
  // proxy stays only as the transport of last resort when no wss is set —
  // set GOV_VIA_PROXY=1 to force the old lane back on for .gov hosts.
  const forceProxy = isGovHost(host) && process.env.GOV_VIA_PROXY === "1";

  if (wss && !forceProxy) {
    const browser = await puppeteer.connect({ browserWSEndpoint: wss });
    log(diag, `connected to Bright Data${isGovHost(host) ? " (.gov via KYC-approved zone)" : ""}`);
    return { browser, launched: false };
  }

  if (proxy) {
    log(diag, `launching local Chromium via proxy ${proxy.server}${isGovHost(host) ? " (.gov host)" : ""}`);
    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: [
        `--proxy-server=${proxy.server}`,
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1280,1800",
      ],
    });
    return { browser, launched: true };
  }

  throw new Error("no transport configured (set BRIGHTDATA_SCRAPING_BROWSER_WSS or VOS_PROXY_URL)");
}

async function shutdown(browser: Browser | undefined, launched: boolean): Promise<void> {
  if (!browser) return;
  try {
    if (launched) await browser.close();
    else await browser.disconnect();
  } catch {
    /* ignore */
  }
}

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
  /**
   * Diagnostic mode. When true the worker dumps the live pager markup at the
   * point the walk stops, so we can see exactly what control advances the
   * pager window past the first block of numbered pages. Costs one keyword.
   */
  pagerDiag?: boolean;
};

export type VosWorkerResult = {
  workerVersion: string;
  status: "ok" | "error";
  /** One entry per page walked, in order. Raw card-grid HTML for the app parser. */
  pagesHtml: string[];
  /**
   * Same pages, gzip+base64. v2.4: 20 pages of raw grid HTML held in memory and
   * then JSON.stringify'd was OOM-killing the Render process right at the end of
   * a deep walk ("worker process restarted mid-run" after page 20). Gzip cuts
   * each page ~15-20x, so deep slices survive. The app decompresses and feeds
   * the SAME parser.
   */
  pagesGz?: string[];
  pagesWalked: number;
  hitPageCap: boolean;
  hitTimeBudget: boolean;
  maxPages: number;
  /** The portal's own "we have found N jobs" banner text, page 1. */
  totalText: string | null;
  /** Source-filter labels actually unchecked on this run. */
  sourcesUnchecked: string[];
  diagnostic: string;
  /** Only set when input.pagerDiag — raw pager markup + candidate controls. */
  pagerDiag?: string;
  error?: string;
};

const CARD_ANCHOR_SEL = 'a[id^="lnkJobOrderTitle_"], a[href*="jobdetail" i], a[id*="lnkTitle" i]';

function log(lines: string[], message: string) {
  lines.push(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

/** Never returns "[object Object]" — puppeteer/proxy layers throw plain objects. */
export function describeErr(e: unknown): string {
  if (e == null) return "unknown error (null/undefined thrown)";
  if (typeof e === "string") return e;
  if (e instanceof Error) {
    const first = (e.stack ?? "").split("\n").slice(0, 4).join(" ⏎ ");
    return `${e.name}: ${e.message}${first ? ` | ${first}` : ""}`;
  }
  if (typeof e === "object") {
    const o = e as Record<string, unknown>;
    const parts = ["name", "message", "error", "reason", "code", "type", "description", "stack"]
      .map((k) => (typeof o[k] === "string" && o[k] ? `${k}=${String(o[k]).slice(0, 400)}` : ""))
      .filter(Boolean)
      .join(" | ");
    if (parts) return parts;
    try {
      return JSON.stringify(e, Object.getOwnPropertyNames(e as object)).slice(0, 800);
    } catch {
      try {
        return JSON.stringify(e).slice(0, 800);
      } catch {
        return `non-serializable ${Object.prototype.toString.call(e)}`;
      }
    }
  }
  return String(e);
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

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
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

/** Return a usable page handle. VOS postbacks sometimes close the old page, so
 *  we fall back to the most recent open page in the browser. */
async function getActivePage(browser: Browser, preferred?: Page): Promise<Page> {
  if (preferred && !preferred.isClosed()) return preferred;
  const pages = await browser.pages();
  const open = pages.filter((p) => !p.isClosed());
  const candidate = open[open.length - 1] ?? pages[pages.length - 1];
  if (!candidate) throw new Error("no pages available in browser");
  return candidate;
}

/** True if the error message means the page/frame handle died. */
function isDeadTargetError(e: unknown): boolean {
  const msg = describeErr(e);
  return /target closed|detached frame|context was destroyed|execution context|protocol error/i.test(msg);
}

/** Evaluate on the active page, re-acquiring the handle if the target died.
 *  VOS postbacks tear down the main frame mid-flight, so one immediate retry is
 *  not enough: the replacement frame needs a beat to attach. Retry a few times
 *  with a short pause, re-resolving the page handle each round. */
async function safeEvaluate<T>(
  browser: Browser,
  activeRef: { page: Page },
  fn: (...args: any[]) => T,
  ...args: any[]
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await activeRef.page.evaluate(fn, ...args);
    } catch (e) {
      lastErr = e;
      if (!isDeadTargetError(e)) throw e;
      await sleep(1_500);
      try {
        activeRef.page = await getActivePage(browser, activeRef.page.isClosed() ? undefined : activeRef.page);
        // Force a fresh handle when the current one is alive but detached.
        await activeRef.page.evaluate(() => 1);
      } catch {
        activeRef.page = await getActivePage(browser);
      }
    }
  }
  throw lastErr;
}


/** Click inside the page, then wait for a possible postback navigation and
 *  re-attach to the resulting page. */
async function clickAndSettle(
  browser: Browser,
  activeRef: { page: Page },
  clickScript: (...args: any[]) => unknown,
  label: string,
  diag: string[],
  timeoutMs = 20_000,
): Promise<boolean> {
  try {
    await safeEvaluate(browser, activeRef, clickScript);
  } catch (e) {
    log(diag, `${label} click failed: ${describeErr(e)}`);
    return false;
  }

  // VOS postbacks can navigate the same tab. Wait briefly for navigation.
  try {
    await activeRef.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: timeoutMs });
  } catch {
    // no navigation happened; that's fine
  }

  // Re-attach in case the old target closed.
  try {
    activeRef.page = await getActivePage(browser, activeRef.page);
  } catch (e) {
    log(diag, `${label} could not re-acquire page: ${describeErr(e)}`);
    return false;
  }

  // Make sure the new page has cards before we trust it.
  try {
    await activeRef.page.waitForFunction(
      (sel: string) => !!document.querySelector(sel),
      { timeout: 45_000 },
      CARD_ANCHOR_SEL,
    );
    return true;
  } catch {
    return false;
  }
}

export type VosProgress = { pagesWalked: number; note: string };

export type VosWorkerOptions = {
  onProgress?: (p: VosProgress) => void;
};

export async function runVosWorker(
  input: VosWorkerInput,
  opts?: VosWorkerOptions,
): Promise<VosWorkerResult> {
  // Pages collected so far. Hoisted OUT of the try on purpose: a detached frame
  // late in the walk used to throw away every page we had already paid for and
  // report "0 cards". Whatever we hold when the session dies still ships.
  const pagesGz: string[] = [];
  const pack = (html: string) => gzipSync(Buffer.from(html, "utf8")).toString("base64");
  let currentPage = 0;
  let hitTimeBudget = false;
  const emit = (note: string) => {
    try {
      opts?.onProgress?.({ pagesWalked: currentPage, note });
    } catch {
      /* progress reporting must never break the walk */
    }
  };
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
  log(
    diag,
    `${VOS_WORKER_VERSION} — ${input.host} kw="${input.keyword}" zip=${input.zip} cap ${maxPages}p budget ${Math.round(budgetMs / 1000)}s`,
  );
  if (!wss && !proxyConfigured()) {
    return errResult(
      diag,
      "no transport configured (set VOS_PROXY_URL for .gov portals, or BRIGHTDATA_SCRAPING_BROWSER_WSS)",
      maxPages,
    );
  }

  let browser: Browser | undefined;
  let initialPage: Page | undefined;
  let launched = false;
  try {
    // Transport choice lives in openBrowser: Bright Data for everything
    // (.gov included since KYC approval), residential proxy only as fallback.
    const opened = await openBrowser(input.host, diag);
    browser = opened.browser;
    launched = opened.launched;

    initialPage = await browser.newPage();
    await applyProxyAuth(initialPage);
    initialPage.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    initialPage.setDefaultTimeout(NAV_TIMEOUT_MS);

    const activeRef = { page: initialPage };

    const prefix = (input.pathPrefix ?? "").replace(/\/$/, "");
    await activeRef.page
      .goto(`https://${input.host}${prefix}/vosnet/Guest.aspx?guesttype=IND`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      })
      .catch((e: unknown) => log(diag, `guest landing skipped: ${describeErr(e)}`));

    // One retry: a timed-out first goto usually means a cold portal, and the
    // second attempt lands in seconds because the session is already warm.
    let navErr: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await activeRef.page.goto(buildSearchUrl(input), {
          waitUntil: "domcontentloaded",
          timeout: NAV_TIMEOUT_MS,
        });
        navErr = null;
        break;
      } catch (e) {
        navErr = e;
        log(diag, `search nav attempt ${attempt} failed: ${describeErr(e)}`);
      }
    }
    if (navErr) throw navErr;
    log(diag, `landed url=${activeRef.page.url()}`);

    await activeRef.page.waitForNetworkIdle({ timeout: 20_000 }).catch(() => null);
    await activeRef.page
      .waitForFunction((sel: string) => !!document.querySelector(sel), { timeout: 45_000 }, CARD_ANCHOR_SEL)
      .then(() => log(diag, "cards present"))
      .catch((e: unknown) => log(diag, `no cards appeared: ${describeErr(e)}`));

    const remainingMs = () => Math.max(0, budgetMs - (Date.now() - startedAt));
    const hasBudget = () => remainingMs() > 8_000;

    /** Cheap signature of the current grid; used to detect a real pager step. */
    const fingerprint = async (): Promise<string> => {
      return safeEvaluate(
        browser!,
        activeRef,
        (sel: string) => {
          const a = Array.from(document.querySelectorAll<HTMLAnchorElement>(sel));
          return `${a.length}|${a[0]?.getAttribute("href") ?? ""}|${a[a.length - 1]?.getAttribute("href") ?? ""}`;
        },
        CARD_ANCHOR_SEL,
      );
    };

    const waitForGridChange = async (before: string): Promise<boolean> => {
      const deadline = Date.now() + Math.min(GRID_WAIT_MS, remainingMs());
      while (Date.now() < deadline) {
        await sleep(500);
        try {
          if ((await fingerprint()) !== before) {
            await sleep(700);
            return true;
          }
        } catch {
          // target may have closed; loop will re-acquire on next fingerprint
        }
      }
      return false;
    };

    /** Grab just the card grid when we can find it; the whole body otherwise. */
    const grabHtml = async (): Promise<string> => {
      return safeEvaluate(browser!, activeRef, () => {
        const container =
          document.querySelector('[id*="CardList"]') ??
          document.querySelector("#ctl00_Main_content_JobSearch") ??
          document.body;
        return (container as HTMLElement).innerHTML;
      });
    };

    // --- Upstream suppression -------------------------------------------
    // Uncheck the junk source channels BEFORE walking the pager. Every page we
    // avoid here is a page we never pay for. Matching is label-substring based
    // and case-insensitive; a label that is not present is simply skipped.
    const unchecked: string[] = [];
    if (input.excludeSources?.length) {
      const sourceLabels = input.excludeSources.map((s) => s.toLowerCase());
      const checkboxSelector =
        'input[type="checkbox"][id*="SourceFilter"], input[type="checkbox"][name*="SourceFilter"], input[type="checkbox"][id*="sourcefilter"]'; // case-insensitive fallback handled below
      const found = await safeEvaluate(
        browser!,
        activeRef,
        (sel: string, labels: string[]) => {
          const out: { id: string; label: string }[] = [];
          document.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            const id = cb.id || "";
            const label = document.querySelector(`label[for="${id}"]`);
            const text = (label?.textContent ?? cb.getAttribute("value") ?? "").toLowerCase();
            const match = labels.find((l) => text.includes(l));
            if (match && (cb as HTMLInputElement).checked) {
              out.push({ id, label: match });
            }
          });
          return out;
        },
        checkboxSelector,
        sourceLabels,
      );
      for (const { id, label } of found) {
        const ok = await clickAndSettle(
          browser!,
          activeRef,
          (id: string) => {
            const cb = document.getElementById(id) as HTMLInputElement | null;
            if (cb) {
              cb.checked = false;
              cb.click();
            }
          },
          `uncheck source ${label}`,
          diag,
        );
        if (ok) {
          unchecked.push(label);
          log(diag, `unchecked source ${label}`);
        }
      }
    }

    // --- Total jobs banner (page 1 only) ----------------------------------
    let totalText: string | null = null;
    try {
      totalText = await safeEvaluate(browser!, activeRef, () => {
        const el =
          document.querySelector("#ctl00_Main_content_lblTotalJobs") ??
          document.querySelector('[id*="TotalJob" i]');
        return el?.textContent?.trim() ?? null;
      });
      if (totalText) log(diag, `total banner: ${totalText.slice(0, 200)}`);
    } catch {
      totalText = null;
    }

    // --- Page walk --------------------------------------------------------
    let hitPageCap = false;
    const nextButtons = [
      'a[id*="Next" i]', // Next/Next >
      'input[id*="Next" i]',
      'a[id*="PageNext" i]',
      'a[title*="next" i]',
      'a[aria-label*="next" i]',
      'a:has-text("Next")',
    ];

    while (currentPage < maxPages && hasBudget()) {
      emit(`walking page ${currentPage + 1}`);

      // Capture current page.
      const html = await grabHtml();
      pagesGz.push(pack(html));
      currentPage++;
      if (currentPage >= maxPages) {
        hitPageCap = true;
        break;
      }

      // Find the pager control for the next page number.
      const before = await fingerprint().catch(() => "");
      const nextPageNum = currentPage + 1;

      // Strategy 1: try a numeric page link for the next page.
      const numericFound = await clickAndSettle(
        browser!,
        activeRef,
        (sel: string, nextPageNum: number) => {
          const numeric = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[id*="Page"], a[id*="PageNumber"], a[href*="Page$"], a[class*="page"]'));
          const target = numeric.find((a) => a.textContent?.trim() === String(nextPageNum));
          if (target) {
            target.click();
            return true;
          }
          return false;
        },
        `numeric page ${nextPageNum}`,
        diag,
        25_000,
      );
      if (numericFound) {
        const changed = await waitForGridChange(before);
        if (!changed) {
          log(diag, `numeric page ${nextPageNum} did not change grid; stopping`);
          break;
        }
        continue;
      }

      // Strategy 2: a generic "Next" control.
      const nextFound = await clickAndSettle(
        browser!,
        activeRef,
        (sels: string[]) => {
          for (const sel of sels) {
            const el = document.querySelector<HTMLElement>(sel);
            if (el && (el as HTMLInputElement).disabled !== true) {
              el.click();
              return sel;
            }
          }
          return null;
        },
        "next button",
        diag,
        25_000,
      );
      if (nextFound) {
        const changed = await waitForGridChange(before);
        if (!changed) {
          log(diag, "next button did not change grid; stopping");
          break;
        }
        continue;
      }

      log(diag, "no further pager control found; stopping");
      break;
    }

    if (!hasBudget()) {
      hitTimeBudget = true;
      log(diag, "time budget exhausted");
    }

    // Build the legacy pagesHtml from gz so callers that expect it still work.
    const pagesHtml = pagesGz.map((g) => {
      const buf = Buffer.from(g, "base64");
      return zlibGunzipSync(buf).toString("utf8");
    });

    return {
      workerVersion: VOS_WORKER_VERSION,
      status: "ok",
      pagesHtml,
      pagesGz,
      pagesWalked: currentPage,
      hitPageCap,
      hitTimeBudget,
      maxPages,
      totalText,
      sourcesUnchecked: unchecked,
      diagnostic: diag.join(" | "),
    };
  } catch (e) {
    const error = describeErr(e);
    log(diag, `fatal: ${error}`);

    // Ship whatever pages we already paid for, even on failure.
    const pagesHtml = pagesGz.map((g) => {
      const buf = Buffer.from(g, "base64");
      return zlibGunzipSync(buf).toString("utf8");
    });

    return {
      workerVersion: VOS_WORKER_VERSION,
      status: "error",
      pagesHtml,
      pagesGz,
      pagesWalked: currentPage,
      hitPageCap: false,
      hitTimeBudget,
      maxPages,
      totalText: null,
      sourcesUnchecked: [],
      diagnostic: diag.join(" | "),
      error,
    };
  } finally {
    if (initialPage) {
      try {
        await initialPage.close();
      } catch {
        /* ignore */
      }
    }
    await shutdown(browser, launched);
  }
}

// Helper used above for decompression; keep at bottom for clarity.
function zlibGunzipSync(buf: Buffer): Buffer {
  const { gunzipSync } = require("node:zlib");
  return gunzipSync(buf);
}
