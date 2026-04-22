// Keep this slightly above the 8 s external wrapper in crawler.ts so Playwright
// self-terminates cleanly before the outer Promise.race resolves null.
const PLAYWRIGHT_TIMEOUT_MS = 20000;

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

      // ── Cloudflare IUAM challenge handling ─────────────────────────────────
      // Cloudflare IUAM shows "Just a moment..." then runs a JS challenge for
      // ~5-10 s before automatically redirecting to the real page.
      // Instead of a fixed wait, we poll until the title changes — this catches
      // the redirect as soon as it happens (often ~6 s) without over-waiting.
      const isCfChallenge =
        (await page.title()) === "Just a moment..." ||
        (await page.title()).toLowerCase().includes("just a moment");

      if (isCfChallenge) {
        console.log(
          "[playwright] Cloudflare challenge detected — waiting for it to resolve...",
        );
        try {
          // Wait up to 15 s for the title to change away from the challenge page.
          // Passed as a string so TypeScript doesn't complain about `document`
          // (this runs in the browser context, not Node.js).
          await page.waitForFunction(
            "!document.title.toLowerCase().includes('just a moment') && document.title !== ''",
            { timeout: 15000, polling: 500 },
          );
          // Extra 2 s after redirect so the real page can finish loading
          await page.waitForTimeout(2000);
          console.log(
            "[playwright] challenge resolved — real page title:",
            await page.title(),
          );
        } catch {
          // Challenge didn't resolve in 15 s — likely Turnstile or Enterprise CF
          console.log("[playwright] challenge did not resolve in time");
        }
      } else {
        // Normal page — 2 s settle is enough
        await page.waitForTimeout(2000);
      }

      console.log("[playwright] page content loaded");
      return await page.content();
    } finally {
      await browser.close();
      console.log("browser closed");
    }
  } catch {
    return null;
  }
}
