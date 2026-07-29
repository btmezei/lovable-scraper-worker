// WorkSource GA (VOS Sapphire) via Bright Data Scraping Browser.
//
// v5.0 — DOM probe build. We still pull statewide and filter locally, but the
// primary output of this version is a structured dump of the ASP.NET page
// controls: every <select>, every __doPostBack link, every pager element, and
// every clickable button. This lets us discover the real control IDs the portal
// uses for location filtering and pagination without guessing.
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
export const WORKSOURCE_GA_WORKER_VERSION = "v5.0-domprobe-2026-07-29";

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
  opts: { zip?: string; radius?: string; resultsUrl?: string; portalCookie?: string } = {}
): Promise<WorksourceGaChunkResult> {
  const wss = process.env.BRIGHTDATA_SCRAPING_BROWSER_WSS;
  const pastedUrl = opts.resultsUrl?.trim();

  const diag: string[] = [];
  log(diag, `${WORKSOURCE_GA_WORKER_VERSION} — DOM probe + statewide direct joblist mode`);
  if (!wss) return errResult(diag, "BRIGHTDATA_SCRAPING_BROWSER_WSS not configured");

  let browser: Browser | undefined;
  try {
    log(diag, "connecting to Bright Data Scraping Browser…");
    browser = await puppeteer.connect({ browserWSEndpoint: wss });
    log(diag, "connected");

    const page = await browser.newPage();
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

    const scrapePage = async (): Promise<WorksourceGaCard[]> => {
      return await page.evaluate(() => {
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
    pushUnique(await scrapePage());
    log(diag, `page 1 unique cards: ${allCards.length}`);

    const MAX_PAGES = 250;
    let consecutiveNoGain = 0;
    for (let p = 2; p <= MAX_PAGES; p++) {
      const before = allCards.length;
      const advanced = await page.evaluate(() => {
        const pagerLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="__doPostBack"]'));
        const nextPager = pagerLinks.find((a) => /Page\$Next|Page\$\d+/i.test(a.getAttribute("href") ?? "") && /next|>|»/i.test(a.textContent ?? ""));
        if (nextPager) { nextPager.click(); return "pager-doPostBack"; }
        const currentPage = document.querySelector<HTMLElement>('.pagerCurrent, span.pager-current, .rgCurrentPage');
        if (currentPage) {
          const currentNum = parseInt((currentPage.textContent ?? "").trim(), 10);
          if (currentNum > 0) {
            const nextLink = pagerLinks.find((a) => (a.textContent ?? "").trim() === String(currentNum + 1));
            if (nextLink) { nextLink.click(); return `pager-num-${currentNum + 1}`; }
          }
        }
        const candidates = Array.from(document.querySelectorAll<HTMLElement>("a, span, input, button, li"));
        const next = candidates.find((el) => {
          const t = (el.textContent ?? el.getAttribute("value") ?? "").trim().toLowerCase();
          return t === "next" || t === "next >" || t === ">" || t === "next »" || t === "»";
        });
        if (next) { (next as HTMLElement).click(); return "text-next"; }
        return null;
      });
      if (!advanced) { log(diag, `no next link at page ${p}`); break; }
      if (p <= 3 || p % 10 === 0) log(diag, `page ${p} advance via ${advanced}`);
      await page.waitForNetworkIdle({ timeout: 15_000 }).catch(() => null);
      await new Promise((r) => setTimeout(r, 1200));
      pushUnique(await scrapePage());
      if (p % 10 === 0) log(diag, `page ${p} cumulative unique: ${allCards.length}`);
      if (allCards.length === before) {
        consecutiveNoGain++;
        if (consecutiveNoGain >= 2) { log(diag, `no new cards for 2 pages, stopping at page ${p}`); break; }
      } else {
        consecutiveNoGain = 0;
      }
    }
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

    await browser.close();
    browser = undefined;

    return {
      workerVersion: WORKSOURCE_GA_WORKER_VERSION,
      status: "ok",
      fetched: allCards.length,
      upserted: 0,
      loggedIn: false,
      totalText,
      cardCount: allCards.length,
      sampleCards: allCards.slice(0, 10),
      allCards: allCards,
      diagnostic: diag.join(" | "),
      domProbe,
    };
  } catch (e) {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
    return errResult(
      diag,
      e instanceof Error ? `${e.message}${e.stack ? " | " + e.stack.slice(0, 400) : ""}` : String(e)
    );
  }
}
