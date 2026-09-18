/**
 * Interaction verification.
 *
 * Code cannot know what behaviours a generated page has — an interaction can be
 * any shape, anywhere. Two strategies cover that:
 *
 *  1. DECLARED CONTRACT — the model that wrote script.js also writes
 *     interactions.json describing what each behaviour should do. This runner
 *     executes those steps and asserts the stated expectations. The model
 *     declares intent; code decides whether it actually happens, so the model
 *     cannot pass itself.
 *
 *  2. DEAD CONTROL SWEEP — needs no declaration: click every control and check
 *     that *something* observably changed (DOM mutation, attribute, scroll,
 *     navigation). A control that does nothing is almost always unfinished work.
 */

export const INTERACTIONS_FILE = "interactions.json";

export const INTERACTIONS_SCHEMA = `{
  "interactions": [
    {
      "name": "short description, e.g. mobile nav opens",
      "viewport": 375,                       // optional; omit for desktop/stage width
      "steps": [                             // performed in order
        { "click": ".nav-toggle" },
        { "setValue": "#email", "value": "not-an-email" },
        { "submit": "form.newsletter" },
        { "scrollTo": 600 },
        { "wait": 400 }
      ],
      "expect": [                            // all must hold after the steps
        { "selector": ".nav-toggle", "attribute": "aria-expanded", "equals": "true" },
        { "selector": "#primary-nav", "hasClass": "is-open" },
        { "selector": ".msg", "textContains": "valid email" },
        { "selector": ".panel", "visible": true },
        { "selector": ".testi__track", "styleChanged": "transform" }   // vs before the steps
      ]
    }
  ]
}`;

/**
 * Run the declared interactions in the page. Returns an array of failures.
 * `spec` is the parsed interactions.json (or null).
 */
export async function runDeclared(page, spec, url, stageW) {
  const list = spec?.interactions;
  if (!Array.isArray(list) || !list.length) return [];
  const fails = [];

  for (const item of list.slice(0, 20)) {
    const vw = Number(item.viewport) > 0 ? Math.round(item.viewport) : stageW;
    await page.setViewportSize({ width: vw, height: 900 });
    // domcontentloaded, not networkidle: behaviour does not wait for photos, and
    // on an asset-heavy page that wait is most of the runtime
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.addStyleTag({ content: "*{transition:none!important;animation-duration:.01s!important}" });

    const result = await page.evaluate(async (item) => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const pick = (sel) => { try { return document.querySelector(sel); } catch { return null; } };
      const problems = [];

      // snapshot the styles any "styleChanged" expectation cares about
      const before = {};
      for (const e of item.expect || []) {
        if (e.styleChanged && e.selector) {
          const el = pick(e.selector);
          before[e.selector + "|" + e.styleChanged] = el
            ? getComputedStyle(el)[e.styleChanged] + "|" + el.scrollLeft + "|" + el.scrollTop
            : null;
        }
      }

      for (const step of item.steps || []) {
        try {
          if (step.click) {
            const el = pick(step.click);
            if (!el) { problems.push(`step click: no element matches "${step.click}"`); continue; }
            el.click();
          } else if (step.setValue) {
            const el = pick(step.setValue);
            if (!el) { problems.push(`step setValue: no element matches "${step.setValue}"`); continue; }
            el.value = step.value ?? "";
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else if (step.submit) {
            const el = pick(step.submit);
            if (!el) { problems.push(`step submit: no element matches "${step.submit}"`); continue; }
            el.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
          } else if (step.scrollTo != null) {
            window.scrollTo(0, Number(step.scrollTo) || 0);
          } else if (step.wait != null) {
            await wait(Math.min(2000, Number(step.wait) || 0));
          }
          await wait(120);
        } catch (e) { problems.push(`step threw: ${e.message}`); }
      }
      await wait(350);

      for (const e of item.expect || []) {
        const el = e.selector ? pick(e.selector) : null;
        if (!el) { problems.push(`expect: no element matches "${e.selector}"`); continue; }

        if (e.attribute != null) {
          const got = el.getAttribute(e.attribute);
          if (String(got) !== String(e.equals))
            problems.push(`${e.selector} [${e.attribute}] is "${got}", expected "${e.equals}"`);
        }
        if (e.hasClass && !el.classList.contains(e.hasClass))
          problems.push(`${e.selector} is missing class "${e.hasClass}" (has "${el.className}")`);
        if (e.notHasClass && el.classList.contains(e.notHasClass))
          problems.push(`${e.selector} still has class "${e.notHasClass}"`);
        if (e.textContains && !el.textContent.toLowerCase().includes(String(e.textContains).toLowerCase()))
          problems.push(`${e.selector} text does not contain "${e.textContains}"`);
        if (e.visible != null) {
          const cs = getComputedStyle(el);
          const shown = cs.display !== "none" && cs.visibility !== "hidden" &&
            parseFloat(cs.opacity) > 0.01 && el.getBoundingClientRect().width > 0;
          if (shown !== !!e.visible)
            problems.push(`${e.selector} is ${shown ? "visible" : "hidden"}, expected ${e.visible ? "visible" : "hidden"}`);
        }
        if (e.styleChanged) {
          const key = e.selector + "|" + e.styleChanged;
          const now = getComputedStyle(el)[e.styleChanged] + "|" + el.scrollLeft + "|" + el.scrollTop;
          if (before[key] === now)
            problems.push(`${e.selector} ${e.styleChanged} did not change (still ${now.split("|")[0]})`);
        }
      }
      return problems;
    }, item);

    if (result.length)
      fails.push({ interaction: item.name || "(unnamed)", viewport: vw, problems: result.slice(0, 6) });
  }

  return fails;
}

/**
 * Click every control and flag the ones that produce no observable change.
 * Requires no declaration, so it catches behaviours nobody thought to describe.
 */
export async function findDeadControls(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const label = (e) => {
      const cls = String(e.className || "").trim().split(/\s+/)[0];
      const txt = (e.textContent || "").trim().slice(0, 24);
      return `${e.tagName.toLowerCase()}${cls ? "." + cls : ""}${txt ? ` "${txt}"` : ""}`;
    };

    const controls = [...document.querySelectorAll(
      'button, [role="button"], a[href^="#"], summary, [onclick]'
    )].filter((e) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
    }).slice(0, 40);

    const dead = [];
    for (const c of controls) {
      // a submit button's job is handled by its form's submit handler
      if (c.type === "submit" && c.form) continue;

      // reset shared state first: a previous control may already have set the
      // hash or scrolled, which would make a working control look inert
      if (location.hash) history.replaceState(null, "", location.pathname);
      window.scrollTo(0, 0);
      await wait(60);

      let mutations = 0;
      const obs = new MutationObserver((recs) => { mutations += recs.length; });
      obs.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, characterData: true,
      });
      const scrollBefore = window.scrollY;
      const hashBefore = location.hash;
      try { c.click(); } catch { /* a throwing handler still counts as wired */ }
      await wait(250);
      obs.disconnect();

      const inert = mutations === 0 && window.scrollY === scrollBefore && location.hash === hashBefore;
      // an in-page link whose target exists is wired by the browser even when
      // the click changes nothing visible (already in view)
      const resolvesInPage =
        c.tagName === "A" && (c.getAttribute("href") || "").startsWith("#") &&
        (() => { try { return !!document.querySelector(c.getAttribute("href")); } catch { return false; } })();

      if (inert && !resolvesInPage) dead.push(label(c));
    }
    return dead;
  });
}
