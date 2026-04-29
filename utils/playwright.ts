// Keep this slightly above the 8 s external wrapper in crawler.ts so Playwright
// self-terminates cleanly before the outer Promise.race resolves null.
import { isCloudflareChallengeHtml } from "./cloudflareCrawl";

const PLAYWRIGHT_TIMEOUT_MS = 35000;

// Realistic desktop UA — helps pass basic JS bot-detection checks.
// Note: Cloudflare Enterprise and similar WAFs also fingerprint the TLS
// handshake and datacenter IP range. For those sites you need a residential
// rotating proxy (BrightData / Oxylabs / Smartproxy) routed through the
// HTTPS_PROXY env var, which Playwright-core respects automatically.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export async function renderWithPlaywright(
  url: string,
): Promise<string | null> {
  try {
    const [{ chromium }, chromiumLib] = await Promise.all([
      import("playwright-core"),
      import("@sparticuz/chromium"),
    ]);
    console.log("chromium started");

    const browser = await chromium.launch({
      headless: true,
      executablePath: await chromiumLib.default.executablePath(),
      args: chromiumLib.default.args,
    });
    console.log("browser launched");
    try {
      // Set UA per-page so it is sent in the initial HTTP request headers
      const page = await browser.newPage({
        userAgent: BROWSER_USER_AGENT,
      });
      console.log("page created");
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: PLAYWRIGHT_TIMEOUT_MS,
      });

      const getPageMarkup = async (): Promise<string> => {
        try {
          const title = await page.title();
          const bodyText = await page.locator("body").innerText().catch(() => "");
          return `<title>${title}</title>\n${bodyText}`;
        } catch {
          return "";
        }
      };

      const isCfChallenge = isCloudflareChallengeHtml(await getPageMarkup());

      if (isCfChallenge) {
        console.log(
          "[playwright] Cloudflare challenge detected — waiting for it to resolve...",
        );
        try {
          await page.waitForFunction(
            `(() => {
              const title = document.title.toLowerCase();
              const bodyText = document.body ? document.body.innerText.toLowerCase() : "";
              const pageText = title + "\\n" + bodyText;

              return !(
                pageText.includes("just a moment") ||
                pageText.includes("performing security verification") ||
                pageText.includes("verification successful. waiting for") ||
                pageText.includes("this website uses a security service to protect against malicious bots") ||
                pageText.includes("performance and security by cloudflare") ||
                pageText.includes("ray id:")
              );
            })()`,
            { timeout: 25000, polling: 500 },
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
      if (isCloudflareChallengeHtml(content)) {
        console.log("[playwright] final page still looks like Cloudflare challenge");
        return null;
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
