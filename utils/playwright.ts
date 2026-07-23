// Keep this slightly above the 8 s external wrapper in crawler.ts so Playwright
// self-terminates cleanly before the outer Promise.race resolves null.
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Cookie } from "playwright-core";
import { isCloudflareChallengeHtml } from "./cloudflareCrawl";

const PLAYWRIGHT_TIMEOUT_MS = 35000;
const CHALLENGE_WAIT_TIMEOUT_MS = 25000;

// Realistic desktop UA — helps pass basic JS bot-detection checks.
// Note: Cloudflare Enterprise and similar WAFs also fingerprint the TLS
// handshake and datacenter IP range. For those sites you need a residential
// rotating proxy (BrightData / Oxylabs / Smartproxy) routed through the
// HTTPS_PROXY env var, which Playwright-core respects automatically.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

chromium.use(StealthPlugin());

const challengeCookiesByOrigin = new Map<string, Cookie[]>();

function isSiteGroundChallengeHtml(html: string): boolean {
  const normalized = html.toLowerCase();
  return (
    normalized.includes("robot challenge screen") ||
    normalized.includes("checking the site connection security") ||
    normalized.includes("/.well-known/sgcaptcha/") ||
    normalized.includes("sgchallenge=")
  );
}

function isForbiddenPageHtml(html: string): boolean {
  const normalized = html.toLowerCase();
  return (
    normalized.includes("<title>403 - forbidden</title>") ||
    (normalized.includes("403 - forbidden") &&
      normalized.includes("access to this page is forbidden"))
  );
}

function isBrowserChallengeHtml(html: string): boolean {
  return (
    isCloudflareChallengeHtml(html) || isSiteGroundChallengeHtml(html)
  );
}

export async function renderWithPlaywright(
  url: string,
): Promise<string | null> {
  try {
    const chromiumLib = await import("@sparticuz/chromium");
    console.log("chromium started");

    const browser = await chromium.launch({
      headless: true,
      executablePath: await chromiumLib.default.executablePath(),
      args: chromiumLib.default.args,
    });
    console.log("browser launched");
    try {
      const origin = new URL(url).origin;
      const context = await browser.newContext({
        userAgent: BROWSER_USER_AGENT,
      });
      const cachedCookies = (challengeCookiesByOrigin.get(origin) ?? []).filter(
        (cookie) => cookie.expires === -1 || cookie.expires > Date.now() / 1000,
      );
      if (cachedCookies.length > 0) {
        await context.addCookies(cachedCookies);
      }

      const page = await context.newPage();
      console.log("page created");
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: PLAYWRIGHT_TIMEOUT_MS,
      });

      const getPageMarkup = async (): Promise<string> => {
        try {
          const title = await page.title();
          const bodyText = await page
            .locator("body")
            .innerText()
            .catch(() => "");
          return `<title>${title}</title>\n${bodyText}`;
        } catch {
          return "";
        }
      };

      const initialMarkup = await getPageMarkup();
      const hasBrowserChallenge = isBrowserChallengeHtml(initialMarkup);

      if (hasBrowserChallenge) {
        console.log(
          "[playwright] browser challenge detected — waiting for it to resolve...",
        );
        try {
          await page.waitForFunction(
            `(() => {
              const title = document.title.toLowerCase();
              const bodyText = document.body ? document.body.innerText.toLowerCase() : "";
              const html = document.documentElement ? document.documentElement.innerHTML.toLowerCase() : "";
              const pageText = title + "\\n" + bodyText + "\\n" + html;

              return !(
                pageText.includes("just a moment") ||
                pageText.includes("performing security verification") ||
                pageText.includes("verification successful. waiting for") ||
                pageText.includes("this website uses a security service to protect against malicious bots") ||
                pageText.includes("performance and security by cloudflare") ||
                pageText.includes("ray id:") ||
                pageText.includes("robot challenge screen") ||
                pageText.includes("checking the site connection security") ||
                pageText.includes("/.well-known/sgcaptcha/") ||
                pageText.includes("sgchallenge=")
              );
            })()`,
            { timeout: CHALLENGE_WAIT_TIMEOUT_MS, polling: 500 },
          );
          await page.waitForTimeout(2000);
          console.log(
            "[playwright] challenge resolved — real page title:",
            await page.title(),
          );
        } catch {
          console.log("[playwright] challenge did not resolve in time");
        }
      } else {
        await page.waitForTimeout(2000);
      }

      const content = await page.content();
      if (isBrowserChallengeHtml(content)) {
        console.log("[playwright] final page still looks like a challenge");
        return null;
      }
      if (isForbiddenPageHtml(content)) {
        console.log("[playwright] final page is forbidden");
        return null;
      }

      const challengeCookies = (await context.cookies(origin)).filter(
        (cookie) => cookie.name === "_I_",
      );
      if (challengeCookies.length > 0) {
        challengeCookiesByOrigin.set(origin, challengeCookies);
      }

      console.log("[playwright] page content loaded");
      return content;
    } finally {
      await browser.close();
      console.log("browser closed");
    }
  } catch {
    return null;
  }
}
