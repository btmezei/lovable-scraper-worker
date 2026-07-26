import { Browser, Page, launch as launchPuppeteer } from "puppeteer-core";

export interface WorksourceGaChunkResult {
  success: boolean;
  allCards: any[];
  error?: string;
  debug?: any;
}

const BASE_URL =
  "https://www.employgeorgia.com/deg/JobSeekers/SearchJobs?type=JS&r=25&fm=1";

let browser: Browser | null = null;

export async function scrapeWorksourceGaChunk(
  radiusMiles: number,
  postalCode: string,
  maxPages: number,
  debug: boolean
): Promise<WorksourceGaChunkResult> {
  const launchUrl =
    process.env.BRIGHTDATA_SCRAPING_BROWSER_WSS ||
    process.env.BRIGHTDATA_WS_ENDPOINT ||
    "";

  if (!launchUrl) {
    return {
      success: false,
      allCards: [],
      error:
        "Missing BRIGHTDATA_SCRAPING_BROWSER_WSS. Set the WebSocket endpoint in Render env.",
    };
  }

  try {
    browser = await launchPuppeteer({
      browserWSEndpoint: launchUrl,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 60000 });

    // Wait for the search form to render.
    await page.waitForSelector("#txtPostalCode", { visible: true, timeout: 30000 });

    // Fill postal code.
    await page.evaluate(() => {
      const el = document.querySelector<HTMLInputElement>("#txtPostalCode");
      if (el) {
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await page.type("#txtPostalCode", postalCode, { delay: 10 });

    // Set radius.
    await page.evaluate((r) => {
      const sel = document.querySelector<HTMLSelectElement>("#ddlRadius");
      if (sel) {
        sel.value = String(r);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }, radiusMiles);

    // Uncheck unwanted sources if checkboxes exist.
    await page.evaluate(() => {
      const sources = [
        "chkSource_NLX",
        "chkSource_PJB",
        "chkSource_News",
        "chkSource_Corporate",
      ];
      for (const id of sources) {
        const cb = document.querySelector<HTMLInputElement>(`#${id}`);
        if (cb && cb.checked) {
          cb.click();
        }
      }
    });

    // Trigger the ASP.NET UpdatePanel verification.
    await page.evaluate(() => {
      const postal = document.querySelector<HTMLInputElement>("#txtPostalCode");
      if (postal) {
        postal.dispatchEvent(new Event("change", { bubbles: true }));
        // Direct __doPostBack call mimics the UpdatePanel trigger.
        if (typeof (window as any).__doPostBack === "function") {
          (window as any).__doPostBack("ctl00$ContentPlaceHolder1$UpdatePanel1", "");
        }
      }
    });

    // Wait for verification token / state to settle.
    await page.waitForFunction(
      () => {
        const verified = document.querySelector<HTMLInputElement>(
          "#hdnPostalCodeVerified"
        );
        return verified && verified.value === "true";
      },
      { timeout: 30000 }
    );

    // Click search.
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
      page.click("#btnSearch"),
    ]);

    const allCards: any[] = [];

    const extractCards = async (p: Page) => {
      return p.evaluate(() => {
        const rows = Array.from(
          document.querySelectorAll("table[id*='dgJobs'] tr, .job-listing-row, .job-row")
        );
        return rows
          .map((row) => {
            const tds = Array.from(row.querySelectorAll("td"));
            const link = row.querySelector("a[href*='JobDetails']");
            return {
              title: link?.textContent?.trim() || tds[0]?.textContent?.trim() || "",
              company: tds[1]?.textContent?.trim() || "",
              location: tds[2]?.textContent?.trim() || "",
              posted: tds[3]?.textContent?.trim() || "",
              url: (link as HTMLAnchorElement)?.href || "",
              rawHtml: row.outerHTML,
            };
          })
          .filter((j) => j.title);
      });
    };

    const clickNext = async (p: Page): Promise<boolean> => {
      const nextLink = await p.$("a[href*='Page$Next'], .pager-next, a:has-text('Next')");
      if (!nextLink) return false;
      const isDisabled = await p.evaluate(
        (el) => el.classList.contains("disabled") || el.getAttribute("disabled"),
        nextLink
      );
      if (isDisabled) return false;
      await Promise.all([
        p.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {}),
        nextLink.click(),
      ]);
      return true;
    };

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      await page.waitForTimeout(1500);
      const cards = await extractCards(page);
      allCards.push(...cards);

      if (debug) {
        console.log(`Page ${pageNum}: extracted ${cards.length} cards`);
      }

      const hasNext = await clickNext(page);
      if (!hasNext) break;
    }

    await browser.close();
    browser = null;

    return {
      success: true,
      allCards,
    };
  } catch (err: any) {
    if (browser) await browser.close().catch(() => {});
    return {
      success: false,
      allCards: [],
      error: err?.message || String(err),
    };
  }
}
