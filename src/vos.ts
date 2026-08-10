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

export const VOS_WORKER_VERSION = "vos-worker-v2.1-frame-resilient-2026-08-10";

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
  log(
    diag,
    `${VOS_WORKER_VERSION} — ${input.host} kw="${input.keyword}" zip=${input.zip} cap ${maxPages}p budget ${Math.round(budgetMs / 1000)}s`,
  );
  if (!wss) return errResult(diag, "BRIGHTDATA_SCRAPING_BROWSER_WSS not configured", maxPages);

  let browser: Browser | undefined;
  let initialPage: Page | undefined;
  try {
    browser = await puppeteer.connect({ browserWSEndpoint: wss });
    log(diag, "connected to Bright Data");

    initialPage = await browser.newPage();
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

    await activeRef.page.goto(buildSearchUrl(input), {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
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
    const sourcesUnchecked: string[] = [];
    const wanted = (input.excludeSources ?? []).filter((s) => s.trim().length > 1);
    if (wanted.length > 0) try {
      const fpBefore = await fingerprint();
      const hits = await safeEvaluate(
        browser!,
        activeRef,
        (labels: string[]) => {
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
        },
        wanted,
      );
      if (hits.length > 0) {
        sourcesUnchecked.push(...hits);
        await clickAndSettle(
          browser!,
          activeRef,
          () => {
            const btn = document.querySelector<HTMLElement>(
              '[id*="btnSearch" i], [id*="btnFilter" i], input[type="submit"][value*="Search" i]',
            );
            btn?.click();
          },
          "source-filter search",
          diag,
        );
        await waitForGridChange(fpBefore);
        log(diag, `unchecked sources: ${hits.join(", ")}`);
      } else {
        log(diag, "no matching source checkboxes found (filter panel absent)");
      }
    } catch (e) {
      // A dead frame here must not kill the slice — we can still walk unfiltered.
      log(diag, `source filter step failed: ${describeErr(e)}`);
      activeRef.page = await getActivePage(browser!, activeRef.page);
    }

    // Bump the page-length dropdown to 100 so each pager step is worth 100 cards.
    // The size options live inside a Bootstrap dropdown that must be OPENED
    // first — clicking a hidden `a.dropdown-item` fires no postback, which is
    // why earlier runs silently stayed at the default page length.
    const sizeOptions = await safeEvaluate(browser!, activeRef, () => {
      const items = Array.from(
        document.querySelectorAll<HTMLElement>('[id*="PageLenMenu" i] a, [id*="PageLen" i] a, div.CardListPagerDD a'),
      );
      return items.map((el) => (el.textContent ?? "").trim()).filter(Boolean).slice(0, 12);
    }).catch(() => [] as string[]);
    log(diag, `page-size options: ${sizeOptions.join("/") || "none found"}`);

    // Diagnostic: dump the exact page-length control markup so we can see what
    // handler actually changes rows-per-page. Cheap — runs on page 1 only.
    let pageLenMarkup: string | null = null;
    if (input.pagerDiag) {
      pageLenMarkup = await safeEvaluate(browser!, activeRef, () => {
        const out: Record<string, unknown> = {};
        const hosts = Array.from(document.querySelectorAll<HTMLElement>('[id*="PageLen" i], div.CardListPagerDD'));
        out.hosts = hosts.slice(0, 6).map((el) => ({
          tag: el.tagName,
          id: el.id || null,
          cls: typeof el.className === "string" ? el.className : null,
          visible: !!el.offsetParent,
          html: el.outerHTML.slice(0, 3000),
        }));
        const links = Array.from(document.querySelectorAll<HTMLElement>("a, li, span, option, select"))
          .filter((el) => /^\s*(5|10|20|50|100)\s*$/.test(el.textContent ?? ""))
          .slice(0, 20)
          .map((el) => ({
            tag: el.tagName,
            id: el.id || null,
            text: (el.textContent ?? "").trim(),
            cls: typeof el.className === "string" ? el.className : null,
            href: el.getAttribute("href"),
            onclick: (el.getAttribute("onclick") ?? "").slice(0, 240) || null,
            parentId: el.parentElement?.id || null,
            parentCls:
              el.parentElement && typeof el.parentElement.className === "string"
                ? el.parentElement.className
                : null,
            visible: !!el.offsetParent,
          }));
        out.sizeLinks = links;
        out.globals = Object.keys(window).filter((k) => /card|pager|pagelen|pagesize/i.test(k)).slice(0, 40);
        return JSON.stringify(out);
      }).catch((e) => `pagelen capture failed: ${describeErr(e)}`);
      log(diag, `pagelen markup captured (${pageLenMarkup?.length ?? 0} chars)`);
    }

    let pageSize = 0;
    try {
    for (const size of ["100", "50", "25", "20"]) {
      if (sizeOptions.length > 0 && !sizeOptions.includes(size)) continue;
      const fp = await fingerprint();

      // 1) Open the Bootstrap dropdown so the size options are really visible.
      //    Some builds bind pageLen only once the menu has been shown.
      await safeEvaluate(browser!, activeRef, () => {
        const toggle = document.querySelector<HTMLElement>('[id^="PageLenMenu" i], [id*="PageLenMenu" i]');
        if (!toggle) return false;
        toggle.click();
        return true;
      }).catch(() => false);
      await sleep(600);

      // 2) Invoke the option. Prefer the real global the inline onclick names
      //    (e.g. `Card_lst_..._CardList.pageLen(100)`), executed via the page's
      //    own eval so it resolves in global scope, and report what it throws.
      const outcome = await safeEvaluate(
        browser!,
        activeRef,
        (sz: string) => {
          const items = Array.from(
            document.querySelectorAll<HTMLElement>(
              'div.CardListPagerDD a, [class*="CardListPagerDD"] a, a.dropdown-item, [id*="PageLen" i] a',
            ),
          );
          const target = items.find((el) => (el.textContent ?? "").trim() === sz);
          if (!target) return "no-option";
          const handler = (target.getAttribute("onclick") ?? "").trim();
          if (handler) {
            try {
              // eslint-disable-next-line no-eval
              (0, eval)(handler);
              return "eval-ok";
            } catch (e: any) {
              try {
                target.click();
                return `eval-failed(${e?.message ?? e}) -> clicked`;
              } catch {
                return `eval-failed(${e?.message ?? e})`;
              }
            }
          }
          target.click();
          return "clicked";
        },
        size,
      ).catch((e) => `invoke-error: ${describeErr(e)}`);
      log(diag, `page size ${size} invoke: ${outcome}`);

      if (await waitForGridChange(fp)) {
        pageSize = Number(size);
        log(diag, `page size -> ${size}`);
        break;
      }
      log(diag, `page size ${size} did not take`);
    }
    } catch (e) {
      // Page-size bump is an optimisation, never a reason to lose the slice.
      log(diag, `page size step failed: ${describeErr(e)}`);
      activeRef.page = await getActivePage(browser!, activeRef.page);
    }
    if (!pageSize) log(diag, "page size unchanged (portal default)");



    /** What the pager itself says about where we are and whether more exists. */
    const pagerState = async () =>
      safeEvaluate(browser!, activeRef, () => {
        const next = document.querySelector<HTMLElement>('[id^="nextPage"], a[id*="nextPage" i]');
        const cls = next ? (typeof next.className === "string" ? next.className : "") : "";
        const parentCls = next?.parentElement && typeof next.parentElement.className === "string"
          ? next.parentElement.className
          : "";
        const body = document.body.innerText || "";
        const m = body.match(/(?:showing|displaying)[^\n]{0,80}/i);
        return {
          hasNext: !!next,
          nextDisabled: /disabled/i.test(`${cls} ${parentCls}`) || next?.getAttribute("aria-disabled") === "true",
          banner: m ? m[0].replace(/\s+/g, " ").trim().slice(0, 120) : null,
        };
      }).catch(() => ({ hasNext: false, nextDisabled: false, banner: null as string | null }));

    const pagesHtml: string[] = [await grabHtml()];
    let currentPage = 1;
    let hitTimeBudget = false;

    const clickAdvance = (want: number) =>
      safeEvaluate(
        browser!,
        activeRef,
        (w: number) => {
          const next = document.querySelector<HTMLElement>('[id^="nextPage"], a[id*="nextPage" i]');
          if (next) {
            next.click();
            return "next-id";
          }
          const clickable = Array.from(
            document.querySelectorAll<HTMLElement>("a, li > a, span[role='button'], button"),
          );
          const numbered = clickable.find((el) => (el.textContent ?? "").trim() === String(w));
          if (numbered) {
            numbered.click();
            return `num-${w}`;
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
        },
        want,
      );

    // In diagnostic mode walk a couple of pages so we can confirm the page size
    // actually took effect (cards-per-page + "Showing X to Y" banner).
    const walkCap = input.pagerDiag ? 3 : maxPages;

    for (let p = 2; p <= walkCap; p++) {
      if (!hasBudget()) {
        hitTimeBudget = true;
        log(diag, `budget spent before page ${p}`);
        break;
      }

      // A stalled step is usually a slow postback, not the end of the result
      // set. Retry the advance before believing the pager is exhausted, and
      // ask the pager itself whether more pages exist before giving up.
      let moved = false;
      let lastHow: string | null = null;
      for (let attempt = 1; attempt <= 3 && !moved && hasBudget(); attempt++) {
        const fp = await fingerprint();
        const advanced = await clickAdvance(currentPage + 1);
        lastHow = advanced;
        if (!advanced) break;

        try {
          await activeRef.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15_000 });
        } catch {
          // no navigation
        }
        activeRef.page = await getActivePage(browser!, activeRef.page);

        moved = await waitForGridChange(fp);
        if (!moved) {
          const st = await pagerState();
          if (st.hasNext && st.nextDisabled) {
            log(diag, `pager reports last page at ${currentPage}${st.banner ? ` (${st.banner})` : ""}`);
            break;
          }
          log(
            diag,
            `advance attempt ${attempt} via ${advanced} stalled at page ${p}${st.banner ? ` (${st.banner})` : ""}`,
          );
          await sleep(2_000);
        }
      }

      if (!moved) {
        if (!lastHow) log(diag, `no next control at page ${p} — pager exhausted`);
        else log(diag, `grid did not refresh after ${lastHow} at page ${p} — stopping`);
        break;
      }

      currentPage = p;
      pagesHtml.push(await grabHtml());
    }


    // Diagnostic capture: what does the pager look like where we stopped?
    let pagerDiag: string | undefined;
    if (input.pagerDiag) {
      pagerDiag = await safeEvaluate(browser!, activeRef, () => {
        const out: Record<string, unknown> = {};
        const isPagerish = (el: Element) =>
          /pag|next|prev|page/i.test(
            `${el.id} ${typeof el.className === "string" ? el.className : ""}`,
          );
        const containers = Array.from(document.querySelectorAll("div, ul, nav, table, td, span")).filter(
          (el) => isPagerish(el) && (el.textContent ?? "").trim().length < 400,
        );
        out.containers = containers.slice(0, 8).map((el) => el.outerHTML.slice(0, 2000));

        const CHROME = /Skipto|ucHelpHeader|MstPageSideMenu|hlLogoLink|PagePreferences|MultiSearch|AssistCntr|Dashboard/i;
        const score = (el: HTMLElement) => {
          const blob = `${el.id} ${el.getAttribute("title") ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("href") ?? ""} ${(el.textContent ?? "").trim()}`;
          let s = 0;
          if (el.offsetParent) s += 100;
          if (/next|»|›|\.\.\./i.test(blob)) s += 60;
          if (/pag/i.test(blob)) s += 40;
          if (/^\s*\d{1,3}\s*$/.test((el.textContent ?? "").trim())) s += 30;
          if (/doPostBack/i.test(`${el.getAttribute("href") ?? ""}${el.getAttribute("onclick") ?? ""}`)) s += 25;
          if (CHROME.test(el.id || "")) s -= 500;
          return s;
        };
        const controls = Array.from(
          document.querySelectorAll<HTMLElement>("a, button, input[type='submit'], input[type='image'], span[role='button'], img"),
        )
          .filter((el) => {
            const blob = `${el.id} ${el.getAttribute("title") ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("href") ?? ""} ${(el.textContent ?? "").trim()}`;
            return /next|pag|»|›|>|\.\.\.|\d{1,3}$/i.test(blob) && blob.trim().length > 0;
          })
          .map((el) => ({ el, s: score(el) }))
          .filter((x) => x.s > -100)
          .sort((a, b) => b.s - a.s)
          .slice(0, 60)
          .map((x) => x.el)
          .map((el) => ({
            tag: el.tagName,
            id: el.id || null,
            text: (el.textContent ?? "").trim().slice(0, 40) || null,
            title: el.getAttribute("title"),
            aria: el.getAttribute("aria-label"),
            href: (el.getAttribute("href") ?? "").slice(0, 160) || null,
            onclick: (el.getAttribute("onclick") ?? "").slice(0, 160) || null,
            alt: el.getAttribute("alt"),
            visible: !!(el as HTMLElement).offsetParent,
          }));
        out.controls = controls;
        out.bodyPagerText =
          (
            Array.from(document.querySelectorAll("*")).find((n) =>
              /page \d+ of \d+/i.test(n.textContent ?? ""),
            )?.textContent ?? ""
          )
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200) || null;
        return JSON.stringify(out);
      });
      // Lead with the page-length markup — that's the live blocker.
      pagerDiag = JSON.stringify({ pageLen: pageLenMarkup, pager: pagerDiag });
      log(diag, `pager diagnostic captured (${pagerDiag?.length ?? 0} chars) at page ${currentPage}`);
    }

    const totalText = await safeEvaluate(browser!, activeRef, () => {
      const el = Array.from(document.querySelectorAll<HTMLElement>("div, span, h1, h2, p")).find((n) =>
        /we have found|jobs? (?:were )?found|results? found/i.test(n.textContent ?? ""),
      );
      return el?.textContent?.replace(/\s+/g, " ").trim().slice(0, 200) ?? null;
    });

    log(diag, `walked ${currentPage} pages, ${pagesHtml.length} html blobs, total="${totalText ?? "?"}"`);

    await browser.disconnect();
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
      pagerDiag,
      diagnostic: diag.join(" | "),
    };
  } catch (e) {
    if (browser) {
      try {
        browser.disconnect();
      } catch {
        /* ignore */
      }
    }
    return errResult(diag, describeErr(e), maxPages);
  }
}
