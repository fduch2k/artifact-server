/**
 * Run inside the artifact's srcdoc sandbox. Its injected content-domain base
 * is needed for resources, but fragment-only links belong to this document.
 *
 * Since @plannotator/ui 0.67 the viewer's bridge owns fragment links: a
 * document capture listener cancels every followed `#` link and scrolls to
 * the element it names. It knows nothing of HTML's `#top`, which scrolls to
 * the document start when no element carries that name, so the click is
 * cancelled and nothing moves (ADR 0046). This listener covers exactly that
 * case. It sits on the window in the capture phase, which every click reaches
 * before the bridge's document listener, and cancels the click so the bridge
 * leaves it alone. Every other fragment link is the bridge's.
 *
 * A click the bridge would pin rather than follow is left to it: the
 * platform modifier, Shift, and the trailing click of a drag that selected
 * text.
 *
 * This function is serialized into an inline script and must be self-contained.
 */
export function installFragmentLinks(): void {
  window.addEventListener("click", (event: MouseEvent): void => {
    if (
      event.defaultPrevented || event.button !== 0 || event.altKey
      || event.ctrlKey || event.metaKey || event.shiftKey
    ) return;
    const selection = window.getSelection();
    if (selection !== null && !selection.isCollapsed) return;
    const element = event.target;
    if (!(element instanceof Element)) return;
    const link = element.closest("a[href]");
    if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("download")) return;
    const target = link.getAttribute("target")
      ?? document.querySelector("base[target]")?.getAttribute("target")
      ?? "";
    if (target !== "" && target.toLowerCase() !== "_self") return;
    const href = link.getAttribute("href")?.trim();
    if (href === undefined || !href.startsWith("#")) return;

    let fragment = href.slice(1);
    try {
      fragment = decodeURIComponent(fragment);
    } catch {
      // An authored literal ID can contain an invalid percent escape.
    }
    if (fragment.toLowerCase() !== "top") return;
    // An element that carries the name is a real target: the bridge scrolls to it.
    if (document.getElementById(fragment) !== null) return;
    if (document.getElementsByName(fragment).length > 0) return;

    event.preventDefault();
    window.scrollTo(0, 0);
  }, true);
}
