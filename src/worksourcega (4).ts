// WorkSource GA (VOS Sapphire) via Bright Data Scraping Browser.
// Ported verbatim from src/lib/worksourcega.server.ts in the Lovable app,
// where puppeteer can't run because Cloudflare Workers lack raw TCP/WS.

import puppeteer, { type Browser, type Page } from "puppeteer-core";

const BASE_URL = "https://www.worksourcegaportal.com";
const GUEST_URL = `${BASE_URL}/vosnet/Guest.aspx?guesttype=IND&whereto=JOBSEARCHADV`;
const NAV_TIMEOUT_MS = 90_000;
const DEFAULT_ZIP = "30303";
const DEFAULT_RADIUS = "75";

export type WorksourceGaCard = {
  title: string;
  employer: string;
  location: string;
  zip: string | null;
  url: string;
  posted: string | null;
};

export type WorksourceGaChunkResult = {
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
  error?: string;
};

function log(lines: string[], message: string) {
  lines.push(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

async function safeTitle(page: Page): Promise<string> {
  try { return await page.title(); } catch { return ""; }
}

async function snapshotVerifyHidden(page: Page): Promise<Record<string, string>> {
  try {
    return await page.evaluate(() => {
      const re = /verif|valid|postal|zip|geo|area|location/i;
      const out: Record<string, string> = {};
      document.querySelectorAll<HTMLInputElement>('input[type="hidden"]').forEach((el) => {
        const id = el.id || el.name;
        if (!id || !re.test(id)) return;
        out[id] = (el.value || "").slice(0, 40);
      });
      return out;
    });
  } catch { return {}; }
}

function pickRadius(options: Array<{ value: string; text: string }>, desired: string): string | null {
  const want = Number(desired);
  if (!Number.isFinite(want)) return null;
  const parsed = options
    .map((o) => ({ ...o, num: Number((o.value.match(/\d+/) ?? o.text.match(/\d+/) ?? [""])[0]) }))
    .filter((o) => Number.isFinite(o.num));
  if (!parsed.length) return null;
  const exact = parsed.find((o) => o.num === want);
  if (exact) return exact.value;
  const under = parsed.filter((o) => o.num <= want).sort((a, b) => b.num - a.num)[0];
  if (under) return under.value;
  return parsed.sort((a, b) => a.num - b.num)[0].value;
}

function errResult(diag: string[], error: string): WorksourceGaChunkResult {
  return {
    status: "error",
    fetched: 0, upserted: 0, loggedIn: false, totalText: null, cardCount: 0,
    sampleCards: [], allCards: [], diagnostic: diag.join(" | "), error,
  };
}

export async function runWorksourceGa(
  opts: { zip?: string; radius?: string } = {}
): Promise<WorksourceGaChunkResult> {
  const wss = process.env.BRIGHTDATA_SCRAPING_BROWSER_WSS;
  const zip = opts.zip ?? DEFAULT_ZIP;
  const radius = opts.radius ?? DEFAULT_RADIUS;

  const diag: string[] = [];
  if (!wss) return errResult(diag, "BRIGHTDATA_SCRAPING_BROWSER_WSS not configured");

  let browser: Browser | undefined;
  try {
    log(diag, "connecting to Bright Data Scraping Browser…");
    browser = await puppeteer.connect({ browserWSEndpoint: wss });
    log(diag, "connected");

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    log(diag, `goto guest: ${GUEST_URL}`);
    await page.goto(GUEST_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    log(diag, `landed: title="${await safeTitle(page)}" url=${page.url()}`);

    // The VOS Sapphire location panel is collapsed by default and the zip
    // filter is hidden behind a specific UI flow. We must:
    //   1. Expand the "Area Selection" header.
    //   2. Click the current area link ("Georgia") to enter edit mode.
    //   3. Select "Zip" from the Area Type dropdown.
    //   4. Wait for the postal-code/radius panel to render.
    //   5. Fill the zip, choose radius, and click "Set Area(s)".
    //   6. Wait for the AJAX VerifyCityPostalCode.ashx call to set
    //      hdnPostalCodeVerified before clicking Search.

    const areaHeaderSel = '[id*="ucLocation"][id*="AreaSelection"], .area-selection-header, [id*="LocationSelection"] a';
    const changeAreaLinkSel = '#ctl00_Main_content_ucLocation_ctlInternalLocationSelection_hlChangeArea';
    const areaTypeSel = '#ctl00_Main_content_ucLocation_ctlInternalLocationSelection_ddlAreatype';
    const postalCodeSel = '#ctl00_Main_content_ucLocation_ctlInternalLocationSelection_txtPostalCode';
    const radiusSel = '#ctl00_Main_content_ucLocation_ctlInternalLocationSelection_rblRadius';
    const setAreaBtnSel = '#ctl00_Main_content_ucLocation_ctlInternalLocationSelection_btnSetArea';
    const searchBtn = '#ctl00_Main_content_btnSearch';

    // 1. Try to expand the area-selection panel by clicking its header/link.
    try {
      const header = await page.$(areaHeaderSel);
      if (header) {
        await header.click();
        log(diag, 'clicked area-selection header');
        await new Promise((r) => setTimeout(r, 800));
      }
    } catch (e) {
      log(diag, `header click skipped: ${(e as Error).message}`);
    }

    // 2. Click "Georgia" / "Change Area" to enter edit mode.
    try {
      await page.waitForSelector(changeAreaLinkSel, { timeout: 10_000 });
      await page.click(changeAreaLinkSel);
      log(diag, 'clicked Change Area link');
      await new Promise((r) => setTimeout(r, 800));
    } catch (e) {
      log(diag, `change-area link not found/clickable: ${(e as Error).message}`);
    }

    // 3. Select "Zip" (value "90") from the Area Type dropdown.
    try {
      await page.waitForSelector(areaTypeSel, { timeout: 10_000 });
      await page.select(areaTypeSel, '90');
      log(diag, 'selected Zip from Area Type dropdown');
      // Wait for areatypeChanged -> displayPostalCode to reveal the zip panel.
      await page.waitForFunction(
        (sel) => {
          const el = document.querySelector<HTMLElement>(sel as string);
          return !!el && el.offsetParent !== null;
        },
        { timeout: 15_000 },
        postalCodeSel
      );
      log(diag, 'postal-code input is visible');
    } catch (e) {
      log(diag, `area-type select failed: ${(e as Error).message}`);
    }

    // 4. Fill zip and radius.
    try {
      await page.waitForSelector(postalCodeSel, { timeout: 10_000 });
      await page.evaluate((sel) => {
        const el = document.querySelector<HTMLInputElement>(sel);
        if (el) el.value = '';
      }, postalCodeSel);
      await page.type(postalCodeSel, zip, { delay: 30 });
      log(diag, `typed zip=${zip}`);
    } catch (e) {
      log(diag, `zip fill failed: ${(e as Error).message}`);
    }

    const radiusValue = await page.evaluate((sel, want) => {
      const wrap = document.querySelector<HTMLElement>(sel);
      if (!wrap) return null;
      const inputs = Array.from(wrap.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
      const parsed = inputs
        .map((i) => ({ el: i, num: Number((i.value.match(/\d+/) ?? [])[0]) }))
        .filter((i) => Number.isFinite(i.num));
      if (!parsed.length) return null;
      const exact = parsed.find((i) => i.num === Number(want));
      const under = parsed.filter((i) => i.num <= Number(want)).sort((a, b) => b.num - a.num)[0];
      const chosen = exact ?? under ?? parsed.sort((a, b) => a.num - b.num)[0];
      chosen.el.checked = true;
      chosen.el.dispatchEvent(new Event('change', { bubbles: true }));
      return chosen.el.value;
    }, radiusSel, radius);
    log(diag, `selected radius value=${radiusValue ?? '?'}`);

    // 5. Click "Set Area(s)" to trigger the areaChanged -> storePostalCode
    //    AJAX verification. This is the only way hdnPostalCodeVerified gets set.
    const hiddenBeforeSet = await snapshotVerifyHidden(page);
    log(diag, `verify hidden BEFORE setarea: ${JSON.stringify(hiddenBeforeSet)}`);

    try {
      await page.waitForSelector(setAreaBtnSel, { timeout: 10_000 });
      await Promise.all([
        page.waitForResponse(
          (resp) => resp.url().includes('/vosnet/Handlers/VerifyCityPostalCode.ashx'),
          { timeout: 20_000 }
        ),
        page.click(setAreaBtnSel),
      ]);
      log(diag, 'Set Area clicked and VerifyCityPostalCode.ashx responded');
    } catch (e) {
      log(diag, `Set Area click/verify failed: ${(e as Error).message}`);
      // Fallback: try evaluating the button's onclick directly.
      try {
        await page.evaluate((sel) => {
          const btn = document.querySelector<HTMLElement>(sel);
          if (btn) (btn as HTMLElement).click();
        }, setAreaBtnSel);
        await new Promise((r) => setTimeout(r, 2000));
        log(diag, 'eval-clicked Set Area fallback');
      } catch (e2) {
        log(diag, `Set Area eval-click failed: ${(e2 as Error).message}`);
      }
    }

    // Wait a beat for the verification callback to populate hidden fields.
    await new Promise((r) => setTimeout(r, 1500));
    const hiddenAfterSet = await snapshotVerifyHidden(page);
    log(diag, `verify hidden AFTER setarea: ${JSON.stringify(hiddenAfterSet)}`);

    // 6. Click Search.
    try {
      log(diag, `clicking ${searchBtn}`);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => null),
        page.click(searchBtn),
      ]);
      await page.waitForNetworkIdle({ timeout: 15_000 }).catch(() => null);
      log(diag, `after search: title="${await safeTitle(page)}" url=${page.url()}`);
    } catch (e) {
      log(diag, `click search failed: ${(e as Error).message}`);
    }

    const JOB_ANCHOR_SEL =
      'a[href*="jobdetail" i], a[href*="viewjobdetail" i], a[href*="jobsummary" i], a[id*="lnkTitle" i]';
    try {
      await page.waitForFunction(
        (sel) => !!document.querySelector(sel as string),
        { timeout: 45_000 }, JOB_ANCHOR_SEL
      );
    } catch { log(diag, `no job-detail anchors appeared`); }
    await new Promise((r) => setTimeout(r, 1500));

    const anchorSample = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll<HTMLAnchorElement>("a"));
      const hits = all
        .map((a) => ({ text: (a.textContent ?? "").trim().slice(0, 60), href: a.getAttribute("href") ?? "", id: a.id }))
        .filter((a) => a.href && /job/i.test(a.href + " " + a.id));
      return { total: all.length, jobLike: hits.slice(0, 15) };
    });
    log(diag, `anchors total=${anchorSample.total} jobLike=${anchorSample.jobLike.length} sample=${JSON.stringify(anchorSample.jobLike.slice(0, 5))}`);

    const SPAM_EMPLOYERS = /swipejobs|swipe jobs/i;
    type Card = {
      title: string; employer: string; location: string; zip: string | null; url: string; posted: string | null;
    };

    const scrapePage = async (): Promise<Card[]> => {
      return await page.evaluate(() => {
        const SKIP_TITLE = /^(view|apply|details|save|share)\b/i;
        const seen = new Set<string>();
        const out: Array<{ title: string; employer: string; location: string; zip: string | null; url: string; posted: string | null }> = [];
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
          out.push({
            title, employer, location,
            zip: zipMatch ? zipMatch[1] : null,
            url: href, posted,
          });
        }
        return out;
      });
    };

    const allCards: Card[] = [];
    const seenKeys = new Set<string>();
    const pushUnique = (cards: Card[]) => {
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

    const MAX_PAGES = 6;
    for (let p = 2; p <= MAX_PAGES; p++) {
      const before = allCards.length;
      const advanced = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a"));
        const next = links.find((a) => {
          const t = (a.textContent ?? "").trim().toLowerCase();
          return t === "next" || t === "next >" || t === ">";
        });
        const target = next ?? links.find((a) => /page\$next|nextpage/i.test(a.getAttribute("href") ?? ""));
        if (!target) return false;
        target.click();
        return true;
      });
      if (!advanced) { log(diag, `no next link at page ${p}`); break; }
      await page.waitForNetworkIdle({ timeout: 15_000 }).catch(() => null);
      await new Promise((r) => setTimeout(r, 1200));
      pushUnique(await scrapePage());
      log(diag, `page ${p} cumulative unique: ${allCards.length}`);
      if (allCards.length === before) break;
    }

    const results = allCards;
    const totalText = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(
        '#ctl00_Main_content_JobCount, #filtered_results, #ctl00_Main_content_ucGSIMultiViewGrid_lblCount'
      );
      return el?.textContent?.trim() || null;
    });
    log(diag, `scraped cards: ${results.length} total=${totalText ?? "?"}`);

    await browser.close();
    browser = undefined;

    return {
      status: "ok",
      fetched: results.length,
      upserted: 0,
      loggedIn: false,
      totalText,
      cardCount: results.length,
      sampleCards: results.slice(0, 10),
      allCards: results,
      diagnostic: diag.join(" | "),
    };
  } catch (e) {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
    return errResult(
      diag,
      e instanceof Error ? `${e.message}${e.stack ? " | " + e.stack.slice(0, 400) : ""}` : String(e)
    );
  }
}
