/**
 * Browsing the way a person does: in the tab they are on.
 *
 * Observed in real use: "open browser" opened Chrome, "search for YouTube"
 * opened a new window, and "open YouTube" from the results page opened yet
 * another. A person would have typed the search into the empty tab, then
 * clicked YouTube on the results. So a page opens in the tab in front when that
 * tab holds nothing worth keeping — an empty tab, a page of search results, or
 * the page this conversation itself just opened — and in a new tab of the same
 * window otherwise. Never a new window.
 *
 * Pure functions: no Electron, no browser, easy to test.
 */

export type TabChoice = "current" | "new-tab";

/** Pages that are only a place to start from. */
export function isBlankPage(url: string): boolean {
  const u = url.trim().toLowerCase();
  if (!u || u === "about:blank" || u === "about:newtab" || u === "about:home") return true;
  // Chrome and its relatives, Safari's start pages.
  return /^(chrome|edge|brave|vivaldi|opera|arc):\/\/(newtab|new-tab-page|startpage|start-page)\b/.test(u) ||
    u.startsWith("chrome-search://") || /^(favorites|topsites|bookmarks):\/\//.test(u);
}

/** A page of search results: moving on from one loses nothing. */
export function isSearchResults(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const path = u.pathname;
  const q = u.searchParams;
  if (/^google\.[a-z.]+$/.test(host)) return path === "/search" || path.startsWith("/maps/search");
  if (host === "bing.com") return path === "/search";
  if (host === "duckduckgo.com" || host === "html.duckduckgo.com") return q.has("q");
  if (host.endsWith("search.yahoo.com")) return path.startsWith("/search");
  if (/^yandex\.[a-z.]+$/.test(host)) return path.startsWith("/search");
  if (host === "youtube.com" || host === "m.youtube.com") return path === "/results";
  if (host === "github.com") return path === "/search";
  if (/^amazon\.[a-z.]+$/.test(host)) return path === "/s";
  if (host === "reddit.com") return path.startsWith("/search");
  if (host.endsWith("wikipedia.org")) return q.has("search") || path.startsWith("/wiki/Special:Search");
  if (host === "stackoverflow.com") return path === "/search";
  if (host === "open.spotify.com") return path.startsWith("/search");
  return false;
}

/** Same site and same page, ignoring "www.", the scheme and a trailing slash. */
export function samePage(a: string, b: string): boolean {
  const key = (s: string) => {
    try {
      const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
      return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "") || "/"}`;
    } catch {
      return s;
    }
  };
  return key(a) === key(b);
}

/**
 * Has the browser arrived at the page it was sent to? Same site, same page,
 * and the same search: a results page for the previous search must not pass
 * for the new one. Redirects that only add parameters still count.
 */
export function landedOn(current: string, requested: string): boolean {
  if (!samePage(current, requested)) return false;
  try {
    const want = new URL(/^[a-z][a-z0-9+.-]*:/i.test(requested) ? requested : `https://${requested}`).searchParams;
    const have = new URL(current).searchParams;
    return ["q", "search_query", "k", "p", "search"].every((key) => !want.has(key) || want.get(key) === have.get(key));
  } catch {
    return true;
  }
}

/**
 * Whether a page may be replaced by the next one, or should be kept and the
 * next one opened in a new tab beside it. `lastPage` is what this
 * conversation last opened: still showing it means the user has not gone
 * anywhere since — a video they clicked into is a different page.
 */
export function chooseTab(currentUrl: string | null, lastPage?: string): TabChoice {
  if (currentUrl === null) return "new-tab";
  if (isBlankPage(currentUrl) || isSearchResults(currentUrl)) return "current";
  if (lastPage && samePage(currentUrl, lastPage)) return "current";
  return "new-tab";
}

// ---------------------------------------------------------------------------
// Clicking
// ---------------------------------------------------------------------------

const ORDINALS: Record<string, number> = {
  first: 1, top: 1, "1st": 1, one: 1,
  second: 2, "2nd": 2, two: 2,
  third: 3, "3rd": 3, three: 3,
  fourth: 4, "4th": 4, four: 4,
  fifth: 5, "5th": 5, five: 5,
  sixth: 6, "6th": 6, seventh: 7, "7th": 7, eighth: 8, "8th": 8, ninth: 9, "9th": 9, tenth: 10, "10th": 10,
};

/**
 * What the user asked to click, lifted from the words: "click on the Sign in
 * button" → "Sign in". Verbatim, as every free-text slot is.
 */
export function clickTarget(transcript: string): string | null {
  const m = transcript
    .trim()
    .replace(/[.?!]+$/, "")
    .match(/\b(?:click|press|tap|hit|select|choose|open|play|watch)\s+(?:on\s+)?(.+)$/i);
  if (!m?.[1]) return null;
  const target = m[1]
    // "play some video from YouTube" while on YouTube: the site is where, not what.
    .replace(/\s+(?:on|from|in)\s+(?:youtube|google|this page|the page|this site|here|there)$/i, "")
    .replace(/^(?:the|that|this)\s+/i, "")
    .replace(/\s+(?:button|link|tab|icon|option|menu item)$/i, "")
    .trim();
  return target || null;
}

/**
 * "the first result", "second link", "top one", "3rd video" → its position.
 * Null when the words name something rather than count it.
 */
export function resultNumber(target: string): number | null {
  const t = target.toLowerCase().trim().replace(/^the\s+/, "");
  // "a video", "some video", "any result": the first one there is.
  if (/^(?:a|an|any|some)\s+(?:(?:search\s+)?results?|links?|videos?|hits?)$/.test(t)) return 1;
  const words = t.split(/\s+/);
  const n = ORDINALS[words[0] ?? ""];
  if (n === undefined) return null;
  const rest = words.slice(1).join(" ");
  return /^(?:(?:search\s+)?results?|links?|videos?|ones?|hits?|entry|entries|)$/.test(rest) ? n : null;
}

/**
 * Words on a button whose press is hard to take back. Clicking one asks first,
 * like quitting an app does.
 */
export function looksDestructive(target: string): boolean {
  return /\b(delete|remove|erase|trash|discard|uninstall|format|send|submit|pay|buy|purchase|order|checkout|check out|sign out|log out|logout|unsubscribe|deactivate|reset|empty|confirm|transfer)\b/i.test(target);
}
