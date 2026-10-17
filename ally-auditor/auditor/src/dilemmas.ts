import type { Page } from "playwright";
import type { AxeBuilder } from "@axe-core/playwright";

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;

export type DilemmaType =
  | "missing-alt" // no alt attribute: axe flags it, vision can suggest the text
  | "generic-alt" // alt exists but is useless ("image", "IMG_2043.jpg")
  | "empty-alt-informative" // alt="" but the image looks like it carries meaning
  | "icon-only-control" // button/link with only an icon and no accessible name
  | "axe-incomplete"; // axe could not decide: a human (or AI) must look

export interface Dilemma {
  type: DilemmaType;
  reason: string;
  selector: string; // readable path, used in reports
  locator: string; // selector Playwright uses to find the element again
  html: string; // snippet of the element's HTML
  alt: string | null;
  ruleId?: string; // only for axe-incomplete
}

interface RawCandidate {
  id: string;
  type: string;
  reason: string;
  selector: string;
  html: string;
  alt: string | null;
}

// alt text that tells a screen-reader user nothing
const GENERIC_ALT =
  /^(image|img|photo|picture|pic|graphic|icon|logo|banner|placeholder|untitled|thumbnail|spacer)$|\.(png|jpe?g|gif|svg|webp)$|^(img|dsc|image|screenshot)[-_ ]?\d+/i;

// an image this big with alt="" is probably not decorative
const MIN_INFORMATIVE_SIZE = 100;

/**
 * Finds elements where a rule alone can't tell whether the page is accessible.
 * Run this AFTER axe, because it tags elements in the DOM (data-a11y-id) so they
 * can be found again for screenshots.
 */
export async function findDilemmas(
  page: Page,
  axeIncomplete: AxeResults["incomplete"],
  maxPerPage = 10
): Promise<Dilemma[]> {
  const raw: RawCandidate[] = await page.evaluate(
    ({ genericSource, minSize }) => {
      if (!(window as any).__name) {
      (window as any).__name = (fn: any) => fn;
    }
      const generic = new RegExp(genericSource, "i");
      const found: RawCandidate[] = [];
      let counter = 0;

      const isVisible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
        );
      };

      const cssPath = (el: Element): string => {
        const parts: string[] = [];
        let current: Element | null = el;
        while (current && current !== document.documentElement) {
          const node: Element = current;
          let part = node.tagName.toLowerCase();
          if (node.id) {
            parts.unshift(`${part}#${node.id}`);
            break;
          }
          const parent: Element | null = node.parentElement;
          if (parent) {
            const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
            if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
          }
          parts.unshift(part);
          current = parent;
        }
        return parts.join(" > ");
      };

      const add = (el: Element, type: string, reason: string) => {
        const id = String(counter++);
        el.setAttribute("data-a11y-id", id);
        found.push({
          id,
          type,
          reason,
          selector: cssPath(el),
          html: el.outerHTML.slice(0, 300),
          alt: el.getAttribute("alt"),
        });
      };

      // 1. Images
      for (const img of Array.from(document.querySelectorAll("img"))) {
        if (!isVisible(img)) continue;
        const role = img.getAttribute("role");
        if (img.getAttribute("aria-hidden") === "true" || role === "presentation" || role === "none") continue;

        const alt = img.getAttribute("alt");
        const rect = img.getBoundingClientRect();

        if (alt === null) {
          add(img, "missing-alt", "Image has no alt attribute; vision model can suggest alt text");
        } else if (alt.trim() === "") {
          const container = img.closest("a[href], button");
          const bigImage = rect.width >= minSize && rect.height >= minSize;
          const onlyContentOfControl = container !== null && (container.textContent ?? "").trim() === "";
          if (bigImage || onlyContentOfControl) {
            add(
              img,
              "empty-alt-informative",
              onlyContentOfControl
                ? 'alt="" but the image is the only content of a link/button'
                : `alt="" on a large image (${Math.round(rect.width)}x${Math.round(rect.height)}); may carry meaning`
            );
          }
        } else if (generic.test(alt.trim())) {
          add(img, "generic-alt", `Alt text "${alt}" is generic and probably not descriptive`);
        }
      }

      // 2. Buttons / links that contain only an icon
      for (const el of Array.from(document.querySelectorAll("button, a[href], [role='button']"))) {
        if (!isVisible(el)) continue;
        if (el.querySelector("[data-a11y-id]")) continue; // already flagged via its image
        const hasText = (el.textContent ?? "").trim().length > 0;
        const hasLabel =
          el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") || el.hasAttribute("title");
        const hasNamedImage = el.querySelector("img[alt]:not([alt=''])") !== null;
        const hasGraphic = el.querySelector("svg, img, i, [class*='icon']") !== null;
        if (!hasText && !hasLabel && !hasNamedImage && hasGraphic) {
          add(el, "icon-only-control", "Control contains only an icon and has no accessible name");
        }
      }

      return found;
    },
    { genericSource: GENERIC_ALT.source, minSize: MIN_INFORMATIVE_SIZE }
  );

  const dilemmas: Dilemma[] = raw.map((c) => ({
    type: c.type as DilemmaType,
    reason: c.reason,
    selector: c.selector,
    locator: `[data-a11y-id="${c.id}"]`,
    html: c.html,
    alt: c.alt,
  }));

  // 3. Anything axe marked "incomplete" (e.g. contrast over a gradient or image)
  for (const rule of axeIncomplete) {
    for (const node of rule.nodes) {
      const [first] = node.target;
      if (node.target.length !== 1 || typeof first !== "string") continue; // skip iframes / shadow DOM for now
      dilemmas.push({
        type: "axe-incomplete",
        reason: `axe could not decide: ${rule.help}`,
        selector: first,
        locator: first,
        html: node.html.slice(0, 300),
        alt: null,
        ruleId: rule.id,
      });
    }
  }

  return dilemmas.slice(0, maxPerPage); // heuristic findings come first, then axe-incomplete
}