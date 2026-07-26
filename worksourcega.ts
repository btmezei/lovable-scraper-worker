// WorkSource GA (VOS Sapphire) via Bright Data Scraping Browser.
// Ported verbatim from src/lib/worksourcega.server.ts in the Lovable app,
// where puppeteer can't run because Cloudflare Workers lack raw TCP/WS.

import puppeteer, { type Browser, type Page } from "puppeteer-core";

const BASE_URL = "https://www.worksourcegaportal.com";
const GUEST_URL = `${BASE_URL}/vosnet/Guest.aspx?guesttype=IND&whereto=JOBSEARCHADV`;
const NAV_TIMEOUT_MS = 90_000;
const DEFAULT_ZIP = "30303";
const DEFAULT_RADIUS = "75";

export type WorksourceGaChunkResult = {
  status: "ok" | "error";
  fetched: number;
  upserted: number;
  loggedIn: boolean;
  totalText: string | null;
  cardCount: number;
  sampleCards: Array<{
    title: string;
    employer: string;
    location: string;
    zip: string | null;
    url: string;
    posted: string | null;
  }>;
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
    sampleCards: [], diagnostic: diag.join(" | "), error,
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
    const zipReady = "#ctl00_Main_content_ucLocation_ctlInternalLocationSelection_txtPostalCode";
    try { await page.waitForSelector(zipReady, { timeout: 45_000 }); }
    catch { log(diag, `zip field never appeared`); }
    log(diag, `landed: title="${await safeTitle(page)}" url=${page.url()}`);

    const formFields = await page.evaluate(() => {
      const re = /search|radius|distance|mile|postal|zip|location|find/i;
      const out: Array<{ tag: string; type: string; name: string; id: string; value?: string }> = [];
      document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select, button").forEach((el) => {
        const type = (el as HTMLInputElement).type ?? "";
        const name = (el as HTMLInputElement).name ?? "";
        const id = el.id ?? "";
        const val = (el as HTMLInputElement).value ?? "";
        const txt = el.textContent ?? "";
        if (!re.test(name) && !re.test(id) && !re.test(val) && !re.test(txt)) return;
        out.push({ tag: el.tagName.toLowerCase(), type, name, id, value: val.slice(0, 60) });
      });
      return out;
    });
    log(diag, `matched form fields: ${formFields.length}`);

    const zipSel = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="text"], input:not([type])'));
      const cand = inputs.find((el) => /zip|postal/i.test(el.name) || /zip|postal/i.test(el.id));
      if (!cand) return null;
      return cand.id ? `#${CSS.escape(cand.id)}` : `[name="${cand.name}"]`;
    });
    log(diag, `zip selector: ${zipSel ?? "?"}`);

    const hiddenBefore = await snapshotVerifyHidden(page);
    log(diag, `verify hidden BEFORE: ${JSON.stringify(hiddenBefore)}`);

    if (zipSel) {
      await page.evaluate((sel) => {
        const el = document.querySelector<HTMLInputElement>(sel);
        if (el) el.value = "";
      }, zipSel);
      await page.type(zipSel, zip, { delay: 30 });
      log(diag, `typed zip=${zip}`);

      await page.evaluate((sel) => {
        const el = document.querySelector<HTMLInputElement>(sel);
        if (!el) return;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      }, zipSel);
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        document.body.focus();
      });
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 20_000 }).catch(() => null);
      const hiddenAfterZip = await snapshotVerifyHidden(page);
      log(diag, `verify hidden AFTER zip blur: ${JSON.stringify(hiddenAfterZip)}`);
    }

    const setAreaClicked = await page.evaluate(() => {
      const btn = document.querySelector<HTMLElement>(
        '[id*="btnSetArea" i], [id*="btnVerify" i], [id*="btnValidate" i], [id*="btnSetLocation" i]'
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (setAreaClicked) {
      log(diag, `clicked SetArea/Verify button`);
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 15_000 }).catch(() => null);
      const hiddenAfterSet = await snapshotVerifyHidden(page);
      log(diag, `verify hidden AFTER setarea: ${JSON.stringify(hiddenAfterSet)}`);
    }

    const radiusInfoFinal = await page.evaluate(() => {
      const sels = Array.from(document.querySelectorAll<HTMLSelectElement>("select"));
      const cand = sels.find(
        (el) => /radius|distance|miles/i.test(el.name) || /radius|distance|miles/i.test(el.id)
      );
      if (!cand) return null;
      return {
        selector: cand.id ? `#${CSS.escape(cand.id)}` : `[name="${cand.name}"]`,
        options: Array.from(cand.options).map((o) => ({ value: o.value, text: o.text })),
        disabled: cand.disabled,
      };
    });
    if (radiusInfoFinal) {
      const chosen = pickRadius(radiusInfoFinal.options, radius);
      log(diag, `radius (final) sel=${radiusInfoFinal.selector} disabled=${radiusInfoFinal.disabled} chosen=${chosen}`);
      if (chosen) {
        await page.select(radiusInfoFinal.selector, chosen).catch((e) =>
          log(diag, `radius select failed: ${(e as Error).message}`)
        );
        await page.waitForNetworkIdle({ idleTime: 600, timeout: 10_000 }).catch(() => null);
      }
    } else {
      log(diag, `radius control not found after verify`);
    }

    const hiddenBeforeSearch = await snapshotVerifyHidden(page);
    log(diag, `verify hidden BEFORE search: ${JSON.stringify(hiddenBeforeSearch)}`);

    const searchBtn = "#ctl00_Main_content_btnSearch";
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
      diagnostic: diag.join(" | "),
      formFields: formFields.slice(0, 40),
    };
  } catch (e) {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
    return errResult(
      diag,
      e instanceof Error ? `${e.message}${e.stack ? " | " + e.stack.slice(0, 400) : ""}` : String(e)
    );
  }
}
