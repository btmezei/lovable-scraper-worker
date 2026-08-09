// WorkSource GA (VOS Sapphire) via Bright Data Scraping Browser.
//
// v5.2.1 — fast statewide page-cap build. We still pull statewide and filter
// locally, but we intentionally return a bounded first batch instead of trying
// to walk all 10,000+ statewide cards in one HTTP request. That keeps Render +
// the app server from hitting a headers-timeout before any JSON comes back.
//
// Rationale: the ASP.NET UpdatePanel-based zip verification is too brittle
// to drive from puppeteer (postback token expires, session cookies rebind,
// etc.). Every other adapter in this app already fetches wide and filters
// against VISIBLE_ZIPS on the app side. We do the same here: land on the
// guest page, run the default statewide search, paginate through every
// page the portal serves, and hand the full card list back. The caller
// (worksourcega.server.ts) applies the corridor filter.
//
// Recruiters are LEFT ON at the search level so we don't strip good
// staffing-agency postings (Aerotek, TEKsystems, etc.). SwipeJobs and
// other gig-app spam are dropped client-side by employer name.
//
// The pastedUrl / portalCookie params from the UI are still honored as an
// override when the caller wants to reproduce a specific manual search,
// but they are no longer required for a normal statewide pull.

import puppeteer, { type Browser, type Page } from "puppeteer-core";

const BASE_URL = "https://www.worksourcegaportal.com";
const NAV_TIMEOUT_MS = 90_000;
const FAST_MAX_PAGES = 5;
const HARD_MAX_PAGES = 40;
const FAST_RUNTIME_BUDGET_MS = 210_000;
const GRID_WAIT_MS = 10_000;
export const WORKSOURCE_GA_WORKER_VERSION = "v5.3.1-tunable-page-cap-depth-telemetry-2026-07-30";

export type PageControlProbe = {
  selects: Array<{ id: string; name: string; value: string; options: Array<{ value: string; text: string }> }>;
  postbackLinks: Array<{ text: string; href: string; target: string }>;
  pagerLinks: Array<{ text: string; href: string }>;
  buttons: Array<{ id: string; name: string; value: string; text: string; type: string }>;
  anchors: Array<{ text: string; href: string; id: string }>;
  totalText: string | null;
  pageTitle: string;
  currentUrl: string;
};

export type WorksourceGaCard = {
  title: string;
  employer: string;
  location: string;
  zip: string | null;
  url: string;
  posted: string | null;
  sourceTag: string | null;
};

export type WorksourceGaChunkResult = {
  workerVersion: string;
  status: "ok" | "error";
  fetched: number;
  upserted: number;
  loggedIn: boolean;
  totalText: string | null;
  cardCount: number;
  pagesWalked: number;
  hitPageCap: boolean;
  hitTimeBudget: boolean;
  maxPages: number;
  sampleCards: WorksourceGaCard[];
  allCards: WorksourceGaCard[];
  diagnostic: string;
  formFields?: Array<{ tag: string; type: string; name: string; id: string; value?: string }>;
  domProbe?: PageControlProbe;
  error?: string;
};

type PortalCookie = { name: string; value: string; url: string };

function log(lines: string[], message: string) {
  lines.push(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

async function safeTitle(page: Page): Promise<string> {
  try { return await page.title(); } catch { return ""; }
}

function errResult(diag: string[], error: string): WorksourceGaChunkResult {
  return {
    workerVersion: WORKSOURCE_GA_WORKER_VERSION,
    status: "error",
    fetched: 0, upserted: 0, loggedIn: false, totalText: null, cardCount: 0,
    pagesWalked: 0, hitPageCap: false, hitTimeBudget: false, maxPages: 0,
    sampleCards: [], allCards: [], diagnostic: diag.join(" | "), error,
  };
}

// Anchor the search to central Atlanta (30303) with the portal's max
// radius (250 miles) so a Bright Data proxy exiting anywhere in the SE
// still returns Georgia results, not whatever's near the exit IP.
// 250 mi from 30303 covers 100% of GA plus overshoot into AL/TN/SC/FL —
// out-of-state cards are dropped by the corridor filter downstream.
function buildStatewideUrl(): string {
  const params = new URLSearchParams({
    origin: "qsb",
    session: "jobsearch",
    t: "h",
    keyword: "",
    zip: "30303",
    distance: "250",
    location: "30303",
    radius: "250",
    ff_requery: "1",
    ff_statereload: "0",
    ff_keyword_option: "1, 2",
  });
  return `${BASE_URL}/vosnet/jobbanks/joblist.aspx?${params.toString()}`;
}

function parsePortalCookies(raw: string | undefined, targetUrl: string): PortalCookie[] {
  if (!raw?.trim()) return [];
  let cookieLine = raw.trim();
  const headerMatch = cookieLine.match(/(?:^|\n)\s*cookie\s*:\s*([^\n\r]+)/i);
  if (headerMatch) cookieLine = headerMatch[1].trim();
  const target = new URL(targetUrl);
  const cookieUrl = `${target.protocol}//${target.hostname}`;
  return cookieLine
    .split(";").map((p) => p.trim())
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq <= 0) return null;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!name || !value) return null;
      return { name, value, url: cookieUrl };
    })
    .filter((c): c is PortalCookie => !!c);
}

const SPAM_EMPLOYERS = /swipejobs|swipe jobs/i;

export async function runWorksourceGa(
  opts: { zip?: string; radius?: string; resultsUrl?: string; portalCookie?: string; maxPages?: number } = {}
): Promise<WorksourceGaChunkResult> {
  const wss = process.env.BRIGHTDATA_SCRAPING_BROWSER_WSS;
  const pastedUrl = opts.resultsUrl?.trim();
  const startedAt = Date.now();
  const maxPages = Math.max(
    1,
    Math.min(HARD_MAX_PAGES, Number.isFinite(Number(opts.maxPages)) && Number(opts.maxPages) > 0 ? Number(opts.maxPages) : FAST_MAX_PAGES)
  );

  const diag: string[] = [];
  log(diag, `${WORKSOURCE_GA_WORKER_VERSION} — statewide, page cap ${maxPages}`);
  if (!wss) return errResult(diag, "BRIGHTDATA_SCRAPING_BROWSER_WSS not configured");

  let browser: Browser | undefined;
  let page: Page | undefined;
  try {
    log(diag, "connecting to Bright Data Scraping Browser…");
    browser = await puppeteer.connect({ browserWSEndpoint: wss });
    log(diag, "connected");

    page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    const usePasted = !!pastedUrl && /joblist\.aspx/i.test(pastedUrl);

    if (!usePasted) {
      log(diag, "seed guest session only — skipping Advanced Search, Change Area, Set Area and zip verification UI");
      await page.goto(`${BASE_URL}/vosnet/Guest.aspx?guesttype=IND`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
      log(diag, `guest title="${await safeTitle(page)}" url=${page.url()}`);
    } else {
      log(diag, "skipping guest landing — pasted URL is session-signed");
    }

    const searchUrl = usePasted ? pastedUrl! : buildStatewideUrl();

    if (usePasted) {
      const cookies = parsePortalCookies(opts.portalCookie, searchUrl);
      if (cookies.length > 0) {
        await page.setCookie(...cookies);
        log(diag, `applied ${cookies.length} pasted portal cookies`);
      }
    }

    log(diag, usePasted
      ? `goto PASTED results url (${searchUrl.length} chars)`
      : `goto ATLANTA-ANCHORED statewide search url (30303 + 250mi, filter locally)`);
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    log(diag, `landed: title="${await safeTitle(page)}" url=${page.url()}`);

    await page.waitForNetworkIdle({ timeout: 20_000 }).catch(() => null);

    // DOM probe — dump every ASP.NET control we can find.
    const domProbe: PageControlProbe = await page.evaluate(() => {
      const totalText = (() => {
        const selectors = [
          "#jobSearchCount", "#ctl00_Main_content_JobCount", "#filtered_results",
          "#ctl00_Main_content_ucGSIMultiViewGrid_lblCount", ".JobSearchCount",
          "[id*='Count']", "[id*='count']",
        ];
        for (const s of selectors) {
          const el = document.querySelector<HTMLElement>(s);
          const txt = el?.textContent?.trim();
          if (txt) return txt;
        }
        return null;
      })();

      const selects = Array.from(document.querySelectorAll<HTMLSelectElement>("select")).map((sel) => ({
        id: sel.id,
        name: sel.name,
        value: sel.value,
        options: Array.from(sel.options).map((o) => ({ value: o.value, text: o.text.trim() })),
      }));

      const postbackLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="__doPostBack"]')).map((a) => ({
        text: (a.textContent ?? "").trim(),
        href: a.getAttribute("href") ?? "",
        target: a.getAttribute("target") ?? "",
      }));

      const pagerLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>("a")).filter((a) => {
        const href = a.getAttribute("href") ?? "";
        const text = (a.textContent ?? "").trim();
        return /page\$|pagenumber|pager|__dopostback.*page/i.test(href) || /^\d+$/.test(text);
      }).map((a) => ({ text: (a.textContent ?? "").trim(), href: a.getAttribute("href") ?? "" }));

      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input[type='button'], input[type='submit']")).map((b) => ({
        id: b.id,
        name: (b as HTMLInputElement).name ?? "",
        value: (b as HTMLInputElement).value ?? "",
        text: (b.textContent ?? "").trim(),
        type: b.type,
      }));

      const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a")).slice(0, 60).map((a) => ({
        text: (a.textContent ?? "").trim().slice(0, 80),
        href: a.getAttribute("href") ?? "",
        id: a.id,
      }));

      return {
        selects,
        postbackLinks,
        pagerLinks,
        buttons,
        anchors,
        totalText,
        pageTitle: document.title,
        currentUrl: window.location.href,
      };
    });
    log(diag, `DOM probe: ${domProbe.selects.length} selects, ${domProbe.postbackLinks.length} postback links, ${domProbe.pagerLinks.length} pager links, ${domProbe.buttons.length} buttons`);

    const JOB_ANCHOR_SEL =
      'a[href*="jobdetail" i], a[href*="viewjobdetail" i], a[href*="jobsummary" i], a[id*="lnkTitle" i]';
    try {
      await page.waitForFunction(
        (sel) => !!document.querySelector(sel as string),
        { timeout: 45_000 },
        JOB_ANCHOR_SEL
      );
      log(diag, "job-detail anchors appeared");
    } catch (e) {
      log(diag, `no job-detail anchors appeared: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));

    const activePage: Page = page;

    const scrapePage = async (): Promise<WorksourceGaCard[]> => {
      return await activePage.evaluate(() => {
        const SKIP_TITLE = /^(view|apply|details|save|share)\b/i;
        const SOURCE_LABELS = [
          "EDU", "GOVT", "SJB", "RECT", "PJB", "NLX", "NEWS", "SM", "JDI", "HOSP", "CORP", "VOL",
        ];
        const SOURCE_LABEL_RE = new RegExp(`\\b(${SOURCE_LABELS.join("|")})\\b`, "i");
        const SOURCE_PREFIX_RE = /Source:\s*([A-Z]{2,})/i;
        const SPAM_EMPLOYERS = /swipejobs|swipe jobs/i;
        const SOURCE_PHRASES: Record<string, string> = {
          "preferred employer": "CORP", corporate: "CORP",
          "education institution": "EDU", education: "EDU",
          government: "GOVT", "state job board": "SJB",
          recruiter: "RECT", "private job board": "PJB",
          "national labor exchange": "NLX", newspaper: "NEWS",
          "social media": "SM", "job distributor": "JDI",
          hospital: "HOSP", volunteer: "VOL",
        };

        const seen = new Set<string>();
        const out: WorksourceGaCard[] = [];
        const anchors = Array.from(
          document.querySelectorAll<HTMLAnchorElement>(
            'a[href*="jobdetail" i], a[href*="viewjobdetail" i], a[href*="jobsummary" i], a[id*="lnkTitle" i]'
          )
        );
        for (const a of anchors) {
          const title = (a.textContent ?? "").trim();
          if (!title || SKIP_TITLE.test(title)) continue;
          const href = new URL(a.getAttribute("href") ?? "", window.location.href).toString();
          const idMatch = href.match(/[?&](?:jobid|jobkey|enc|job)[=]([^&]+)/i);
          const key = idMatch ? idMatch[1] : href;
          if (seen.has(key)) continue;
          seen.add(key);

          let row: HTMLElement = a;
          for (let i = 0; i < 8 && row.parentElement; i++) {
            row = row.parentElement;
            if (row.tagName === "TR" || row.getAttribute("role") === "row") break;
            if ((row.textContent ?? "").length > title.length + 60) break;
          }
          const rowText = (row.textContent ?? "").replace(/\s+/g, " ").trim();
          const body = rowText.startsWith(title) ? rowText.slice(title.length).trim() : rowText;

          const postedMatch =
            body.match(/(\d+\s+(?:day|week|month|hour|minute)s?\s+ago)/i) ??
            body.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
          const posted = postedMatch ? postedMatch[1].trim() : null;

          const locMatches = Array.from(body.matchAll(/([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})\b/g));
          const location = locMatches.length ? locMatches[locMatches.length - 1][1] : "";

          let employer = body;
          if (locMatches.length) {
            const firstLoc = locMatches[0];
            employer = body.slice(0, firstLoc.index ?? 0).trim();
          }
          if (posted) employer = employer.replace(posted, "").trim();
          employer = employer.replace(/[\s,•|-]+$/g, "").trim();
          if (employer.length > 120) employer = employer.slice(0, 120);

          const zipMatch = body.match(/\b(\d{5})(?:-\d{4})?\b/);

          let sourceTag: string | null = null;
          const candidates: string[] = [body];
          row.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
            if (img.alt) candidates.push(img.alt);
            if (img.title) candidates.push(img.title);
          });
          row.querySelectorAll<HTMLElement>("*").forEach((el) => {
            if (el.title) candidates.push(el.title);
          });
          for (const txt of candidates) {
            const clean = txt.replace(/\s+/g, " ").trim();
            const prefixMatch = clean.match(SOURCE_PREFIX_RE);
            if (prefixMatch) { sourceTag = prefixMatch[1].toUpperCase(); break; }
            const labelMatch = clean.match(SOURCE_LABEL_RE);
            if (labelMatch) { sourceTag = labelMatch[1].toUpperCase(); break; }
            for (const [phrase, abbr] of Object.entries(SOURCE_PHRASES)) {
              if (clean.toLowerCase().includes(phrase)) { sourceTag = abbr; break; }
            }
            if (sourceTag) break;
          }

          if (SPAM_EMPLOYERS.test(employer) || SPAM_EMPLOYERS.test(title)) continue;

          out.push({
            title, employer, location,
            zip: zipMatch ? zipMatch[1] : null,
            url: href, posted, sourceTag,
          });
        }
        return out;
      });
    };

    const allCards: WorksourceGaCard[] = [];
    const seenKeys = new Set<string>();
    const pushUnique = (cards: WorksourceGaCard[]) => {
      for (const c of cards) {
        const idMatch = c.url.match(/[?&](?:jobid|jobkey|enc|job)[=]([^&]+)/i);
        const key = idMatch ? idMatch[1] : c.url;
        if (seenKeys.has(key)) continue;
        if (SPAM_EMPLOYERS.test(c.employer) || SPAM_EMPLOYERS.test(c.title)) continue;
        seenKeys.add(key);
        allCards.push(c);
      }
    };
    // --- v5.1: the pager anchors are href="javascript:void(0)" with JS click
    // handlers (GSI MultiViewGrid), NOT __doPostBack hrefs. So we click by
    // visible text and wait for the grid fingerprint to change.
    const gridFingerprint = async (): Promise<string> =>
      await activePage.evaluate(() => {
        const a = document.querySelectorAll<HTMLAnchorElement>(
          'a[href*="jobdetail" i], a[href*="viewjobdetail" i], a[href*="jobsummary" i], a[id*="lnkTitle" i]'
        );
        const first = a[0]?.getAttribute("href") ?? "";
        const last = a[a.length - 1]?.getAttribute("href") ?? "";
        return `${a.length}|${first}|${last}`;
      });

    const remainingBudgetMs = (): number => Math.max(0, FAST_RUNTIME_BUDGET_MS - (Date.now() - startedAt));
    const hasBudget = (): boolean => remainingBudgetMs() > 5_000;

    const waitForGridChange = async (before: string, ms = GRID_WAIT_MS): Promise<boolean> => {
      const boundedMs = Math.max(1_500, Math.min(ms, remainingBudgetMs()));
      const deadline = Date.now() + boundedMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 600));
        if ((await gridFingerprint()) !== before) {
          await new Promise((r) => setTimeout(r, 600));
          return true;
        }
      }
      return false;
    };

    // Bump the page size to the largest option the pager offers (50).
    for (const size of ["50", "20"]) {
      const fp = await gridFingerprint();
      const clicked = await page.evaluate((sz) => {
        const links = Array.from(document.querySelectorAll<HTMLElement>("a, li > a, span[role='button']"));
        const target = links.find((el) => (el.textContent ?? "").trim() === sz && /void\(0\)|^$|#/.test(el.getAttribute("href") ?? ""));
        if (!target) return false;
        target.click();
        return true;
      }, size);
      if (clicked) {
        const changed = await waitForGridChange(fp);
        log(diag, `page size -> ${size} (${changed ? "grid refreshed" : "no visible change"})`);
        if (changed) break;
      }
    }

    pushUnique(await scrapePage());
    log(diag, `page 1 unique cards: ${allCards.length}`);

    const MAX_PAGES = maxPages;
    let consecutiveNoGain = 0;
    let currentPage = 1;
    let hitTimeBudget = false;
    for (let p = 2; p <= MAX_PAGES; p++) {
      if (!hasBudget()) { hitTimeBudget = true; log(diag, `runtime budget reached before page ${p}; returning partial batch`); break; }
      const before = allCards.length;
      const fp = await gridFingerprint();
      const wanted = currentPage + 1;
      const advanced = await page.evaluate((want: number) => {
        const clickable = Array.from(document.querySelectorAll<HTMLElement>("a, li > a, span[role='button'], button"));
        // 1) numbered pager link for the next page
        const numbered = clickable.find((el) => (el.textContent ?? "").trim() === String(want));
        if (numbered) { numbered.click(); return `num-${want}`; }
        // 2) generic next control
        const next = clickable.find((el) => {
          const t = (el.textContent ?? (el as HTMLInputElement).value ?? "").trim().toLowerCase();
          return t === "next" || t === "next >" || t === ">" || t === "next »" || t === "»" || t === "›";
        });
        if (next) { next.click(); return "text-next"; }
        // 3) legacy __doPostBack pager
        const pb = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="__doPostBack"]'))
          .find((a) => /Page\$Next|Page\$\d+/i.test(a.getAttribute("href") ?? ""));
        if (pb) { pb.click(); return "postback"; }
        return null;
      }, wanted);
      if (!advanced) { log(diag, `no next control at page ${p}`); break; }

      const changed = await waitForGridChange(fp);
      if (!changed) { log(diag, `grid did not refresh after ${advanced} (page ${p}) — stopping`); break; }
      currentPage = wanted;
      if (p <= 3 || p % 10 === 0) log(diag, `page ${p} advance via ${advanced}`);

      pushUnique(await scrapePage());
      if (p % 10 === 0) log(diag, `page ${p} cumulative unique: ${allCards.length}`);
      if (allCards.length === before) {
        consecutiveNoGain++;
        if (consecutiveNoGain >= 3) { log(diag, `no new cards for 3 pages, stopping at page ${p}`); break; }
      } else {
        consecutiveNoGain = 0;
      }
    }
    const hitPageCap = currentPage >= MAX_PAGES;
    if (hitPageCap) log(diag, `page cap ${MAX_PAGES} reached; slice is TRUNCATED (more results exist)`);
    else log(diag, `pager exhausted at page ${currentPage} of cap ${MAX_PAGES}; slice is COMPLETE`);
    log(diag, `final cumulative unique: ${allCards.length}`);


    const totalText = await page.evaluate(() => {
      const selectors = [
        "#jobSearchCount", "#ctl00_Main_content_JobCount", "#filtered_results",
        "#ctl00_Main_content_ucGSIMultiViewGrid_lblCount", ".JobSearchCount",
      ];
      for (const s of selectors) {
        const el = document.querySelector<HTMLElement>(s);
        const txt = el?.textContent?.trim();
        if (txt) return txt;
      }
      return null;
    });
    log(diag, `scraped cards: ${allCards.length} totalText=${totalText ?? "?"}`);

    await page.close().catch(() => null);
    page = undefined;
    browser.disconnect();
    browser = undefined;

    return {
      workerVersion: WORKSOURCE_GA_WORKER_VERSION,
      status: "ok",
      fetched: allCards.length,
      upserted: 0,
      loggedIn: false,
      totalText,
      cardCount: allCards.length,
      pagesWalked: currentPage,
      hitPageCap,
      hitTimeBudget,
      maxPages: MAX_PAGES,
      sampleCards: allCards.slice(0, 10),
      allCards: allCards,
      diagnostic: diag.join(" | "),
      domProbe,
    };
  } catch (e) {
    if (page) { try { await page.close(); } catch { /* ignore */ } }
    if (browser) { try { browser.disconnect(); } catch { /* ignore */ } }
    return errResult(
      diag,
      e instanceof Error ? `${e.message}${e.stack ? " | " + e.stack.slice(0, 400) : ""}` : String(e)
    );
  }
}
