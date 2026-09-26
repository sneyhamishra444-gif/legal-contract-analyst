/**
 * Capture the README screenshots by driving the running app with Chrome.
 *
 *   npm run dev            # in one terminal
 *   npm run shots          # in another
 *
 * There are no dependencies here on purpose: Node's built-in fetch and WebSocket
 * talk to Chrome's DevTools Protocol directly, so this works on a machine where
 * installing a browser-automation package is not practical. Chrome is launched
 * headless with a throwaway profile, pointed at the app, and asked for
 * `Page.captureScreenshot` at each step. Nothing is mocked: the documents are
 * uploaded through the real API and the questions are typed into the real
 * textarea, so a screenshot cannot show something the app does not do.
 *
 * All output lands in docs/screenshots/.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.env.APP_URL ?? "http://127.0.0.1:3000";
const PORT = Number(process.env.CDP_PORT ?? 9333);
const OUT = path.resolve(process.cwd(), "docs", "screenshots");
const WIDTH = 1440;
const HEIGHT = 1000;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

function findBrowser() {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("No Chrome or Edge binary found. Set CHROME_PATH to one.");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ CDP --- */

class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #events = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.#pending.has(message.id)) {
        const { resolve, reject } = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      const listeners = this.#events.get(message.method);
      if (listeners) for (const listener of listeners) listener(message.params);
    });
  }

  static async attach(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(`Could not open ${url}`)), { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  on(method, listener) {
    const listeners = this.#events.get(method) ?? [];
    listeners.push(listener);
    this.#events.set(method, listeners);
  }

  once(method, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
      this.on(method, (params) => {
        clearTimeout(timer);
        resolve(params);
      });
    });
  }

  /** Evaluate an expression in the page and return its value. */
  async eval(expression, { awaitPromise = false } = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "Evaluation failed");
    }
    return result.result.value;
  }

  /** Poll an expression until it is truthy. */
  async waitFor(expression, label, timeoutMs = 150_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.eval(expression)) return;
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async goto(url) {
    const loaded = this.once("Page.loadEventFired").catch(() => null);
    await this.send("Page.navigate", { url });
    await loaded;
    await this.waitFor("document.readyState === 'complete'", `load of ${url}`);
    // Client components fetch their data after hydration.
    await sleep(900);
  }

  /**
   * Navigate until the page is really up.
   *
   * A dev server can answer a first navigation with an empty shell while it
   * finishes compiling, and a blank page satisfies "readyState complete" just as
   * happily as a rendered one. Reloading is the fix; failing the capture is not.
   */
  async open(url, condition, label, attempts = 4) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this.goto(url);
      try {
        await this.waitFor(condition, label, 20_000);
        return;
      } catch {
        if (attempt === attempts) throw new Error(`Timed out waiting for ${label}`);
        console.warn(`  ${label}: not rendered yet (attempt ${attempt}), reloading`);
      }
    }
  }

  async screenshot(name) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`  wrote ${path.relative(process.cwd(), file)}`);
  }
}

/* ------------------------------------------------- page-side helpers ------ */

/**
 * Text-content matchers, used for clicking by visible label rather than by
 * brittle generated class names.
 *
 * `findByText` matches the start of the label, which is right when part of it is
 * dynamic ("All 12", "Critical 3"). `findByExactText` is needed where one label
 * is a prefix of another: the navigation link "Compare versions" would otherwise
 * swallow a click meant for the "Compare" button.
 */
const findByText = (text, selector = "button, a") => `
  [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find((element) => element.textContent.trim().replace(/\\s+/g, " ").startsWith(${JSON.stringify(text)}))
`;

const findByExactText = (text, selector = "button, a") => `
  [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find((element) => element.textContent.trim().replace(/\\s+/g, " ") === ${JSON.stringify(text)})
`;

/**
 * `innerText` reflects CSS, so a heading styled `text-transform: uppercase`
 * reads back uppercased. All body-text checks go through this so a purely
 * cosmetic change to a label cannot break the capture.
 */
const bodyHas = (text) => `document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`;

/** React tracks its own value; setting `.value` directly does not notify it. */
const setTextarea = (text) => `(() => {
  const element = document.querySelector("textarea");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(element, ${JSON.stringify(text)});
  element.dispatchEvent(new Event("input", { bubbles: true }));
  return element.value;
})()`;

/* ------------------------------------------------------------------ run --- */

/**
 * Start from an empty library so the captures are the same every run. Deleting a
 * document also drops the conversations that referenced it, so this clears the
 * saved chat history too — otherwise a second run would screenshot the first
 * run's answers stacked above the new one.
 */
async function resetLibrary() {
  const { documents } = await fetch(`${APP}/api/documents`).then((response) => response.json());
  for (const document of documents) {
    await fetch(`${APP}/api/documents?id=${document.id}`, { method: "DELETE" });
  }
  if (documents.length > 0) console.log(`cleared ${documents.length} existing document(s)`);
}

async function upload(fileName, type) {
  const bytes = fs.readFileSync(path.resolve(process.cwd(), "fixtures", fileName));
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), fileName);
  const response = await fetch(`${APP}/api/documents`, { method: "POST", body: form });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${fileName}: ${payload.message ?? response.status}`);
  console.log(`  uploaded ${fileName} (${payload.document.pageCount} pages, ${payload.document.charCount} chars)`);
  return payload.document;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const health = await fetch(`${APP}/api/health`).then((response) => response.json());
  console.log(`app: ${health.database}`);
  console.log(`provider: ${health.provider.mode}`);

  await resetLibrary();
  console.log("uploading fixtures…");
  const agreement = await upload("services-agreement.pdf", "application/pdf");
  const original = await upload("services-agreement.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const revised = await upload("services-agreement-revised.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const large = await upload("large-master-agreement.pdf", "application/pdf");

  // In development Next compiles a route on its first request. Warm every page
  // over plain HTTP first, so the browser is never waiting on a compile and the
  // capture timeouts stay about the app rather than about the bundler.
  console.log("warming routes…");
  for (const url of [
    `${APP}/`,
    `${APP}/documents/${agreement.id}`,
    `${APP}/documents/${agreement.id}?also=${original.id}`,
    `${APP}/documents/${large.id}`,
    `${APP}/compare?left=${original.id}&right=${revised.id}`,
  ]) {
    await fetch(url);
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lca-shots-"));
  const browser = spawn(
    findBrowser(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let cdp = null;
  try {
    let target = null;
    for (let attempt = 0; attempt < 60 && !target; attempt += 1) {
      await sleep(500);
      try {
        const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((response) => response.json());
        target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl) ?? null;
      } catch {
        // Chrome is still starting.
      }
    }
    if (!target) throw new Error("Chrome did not expose a page target.");

    cdp = await Cdp.attach(target.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });

    console.log("capturing…");

    // 1. Upload and library.
    await cdp.open(`${APP}/`, `${bodyHas("DOCUMENT LIBRARY")} && ${bodyHas("large-master-agreement.pdf")}`, "the library");
    await cdp.screenshot("01-upload-and-library");

    // 2. A question and its verified quote.
    await cdp.open(`${APP}/documents/${agreement.id}`, "document.querySelector('textarea') !== null", "the chat box");
    await cdp.eval(setTextarea("What is the liability cap?"));
    await cdp.eval(`${findByText("Ask")}.click()`);
    await cdp.waitFor(bodyHas("Verified in document"), "a verified quote", 120_000);
    // The Stop button exists only while a stream is open, so its absence is the
    // signal that the answer is complete (the step log also says "searching…",
    // so its text cannot be used for this).
    await cdp.waitFor(`${findByExactText("Stop")} === undefined`, "the answer to finish", 120_000);
    await sleep(600);
    await cdp.screenshot("02-chat-with-verified-quote");

    // 3. Clicking the quote opens and highlights the passage.
    await cdp.eval(`${findByText("Show in document")}.click()`);
    await cdp.waitFor("document.querySelector('[data-active=\"true\"]') !== null", "the highlighted passage", 30_000);
    await sleep(700);
    await cdp.screenshot("03-citation-highlight");

    // 4. One question across two documents.
    await cdp.open(`${APP}/documents/${agreement.id}?also=${original.id}`, "document.querySelector('textarea') !== null", "the chat box");
    await cdp.eval(setTextarea("How do the two versions differ on payment terms and liability?"));
    await cdp.eval(`${findByText("Ask")}.click()`);
    await cdp.waitFor(bodyHas("Verified in document"), "a verified quote", 120_000);
    await sleep(1200);
    await cdp.screenshot("04-multi-document-answer");

    // 5. Clause-level comparison of the two versions.
    await cdp.open(`${APP}/compare?left=${original.id}&right=${revised.id}`, `${findByExactText("Compare")} !== undefined`, "the compare button");
    await cdp.eval(`${findByExactText("Compare")}.click()`);
    await cdp.waitFor(bodyHas("What changed, in plain language"), "the comparison", 120_000);
    await cdp.waitFor(bodyHas("reworded only"), "the change list", 120_000);
    await sleep(1200);
    await cdp.screenshot("05-document-comparison");

    // 6. A large document, and the honest statement of how much was read.
    await cdp.open(`${APP}/documents/${large.id}`, "document.querySelector('textarea') !== null", "the chat box");
    await cdp.eval(setTextarea("What is the liability cap?"));
    await cdp.eval(`${findByText("Ask")}.click()`);
    await cdp.waitFor(bodyHas("Verified in document"), "a verified quote", 120_000);
    await sleep(1500);
    await cdp.screenshot("06-large-document-scope");

    console.log("done.");
  } catch (error) {
    // A capture failure is usually a selector that no longer matches. Say what
    // the browser is actually looking at instead of only that it timed out.
    if (cdp) {
      const state = await cdp
        .eval("location.href + '\\n' + document.body.innerText.slice(0, 400)")
        .catch(() => "(page not reachable)");
      console.error(`\npage at failure:\n${state}`);
    }
    throw error;
  } finally {
    browser.kill();
  }
}

main().catch((error) => {
  console.error(`\nfailed: ${error.message}`);
  process.exitCode = 1;
});
