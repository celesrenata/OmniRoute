/**
 * Fullscreen helpers for the Atomic scene host (operator directive 35). Pure DOM,
 * no `three`. The host element (canvas + labels + detail panel + legend) is the
 * fullscreen target, so everything goes fullscreen together.
 *
 * Native Fullscreen API first (desktop, Android, iPad via the webkit prefix). Where
 * the element API is missing (iPhone Safari only allows <video> fullscreen) a
 * **pseudo-fullscreen** fallback pins the host over the whole viewport with
 * `position: fixed`, locks page scroll, and exits on Escape. Both paths emit a
 * `fullscreenchange` event on `document`, so every existing listener (the controls
 * chip, the detail-view recomposition) reacts the same way.
 */
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};

/** Marks the host while the pseudo-fullscreen fallback is active. */
export const PSEUDO_FS_ATTR = "data-atomic-pseudo-fullscreen";

/** Ancestor properties that would trap a `position: fixed` host inside its card. */
const CONTAINING_BLOCK_PROPS = [
  "transform",
  "filter",
  "backdrop-filter",
  "-webkit-backdrop-filter",
  "perspective",
  "contain",
  "will-change",
] as const;

type PseudoState = {
  host: HTMLElement;
  hostStyle: string;
  rootOverflow: string;
  bodyOverflow: string;
  ancestors: Array<{ el: HTMLElement; style: string }>;
  onKey: (e: KeyboardEvent) => void;
};
let pseudo: PseudoState | null = null;

function nativeSupported(host: HTMLElement): boolean {
  const doc = document as FsDocument;
  if (doc.fullscreenEnabled === false && doc.webkitFullscreenEnabled !== true) return false;
  return (
    typeof host.requestFullscreen === "function" ||
    typeof (host as FsElement).webkitRequestFullscreen === "function"
  );
}

function emitChange(): void {
  if (typeof document.dispatchEvent !== "function" || typeof Event === "undefined") return;
  document.dispatchEvent(new Event("fullscreenchange"));
}

/** True when the host can go fullscreen, natively or via the pseudo fallback (false only without a DOM). */
export function fullscreenSupported(host: HTMLElement | null): boolean {
  return Boolean(host) && typeof document !== "undefined";
}

/** True when the browser's native API will be used (false = pseudo-fullscreen fallback). */
export function nativeFullscreenSupported(host: HTMLElement | null): boolean {
  if (!host || typeof document === "undefined") return false;
  return nativeSupported(host);
}

/** True while `host` is fullscreen (native or pseudo). */
export function isHostFullscreen(host: HTMLElement | null): boolean {
  if (!host || typeof document === "undefined") return false;
  if (pseudo?.host === host) return true;
  const el = document.fullscreenElement ?? (document as FsDocument).webkitFullscreenElement;
  return el === host;
}

function enterPseudo(host: HTMLElement): void {
  if (pseudo) exitPseudo();
  const root = document.documentElement;
  const ancestors: PseudoState["ancestors"] = [];
  for (let el = host.parentElement; el && el !== document.body; el = el.parentElement) {
    const cs = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
    const traps = cs
      ? CONTAINING_BLOCK_PROPS.some((p) => {
          const v = cs.getPropertyValue(p);
          return v !== "" && v !== "none" && v !== "auto" && v !== "normal";
        })
      : false;
    if (traps) {
      ancestors.push({ el, style: el.getAttribute("style") ?? "" });
      for (const p of CONTAINING_BLOCK_PROPS) el.style.setProperty(p, "none", "important");
    }
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      exitPseudo();
      emitChange();
    }
  };
  pseudo = {
    host,
    hostStyle: host.getAttribute("style") ?? "",
    rootOverflow: root.style.overflow,
    bodyOverflow: document.body.style.overflow,
    ancestors,
    onKey,
  };
  host.setAttribute(PSEUDO_FS_ATTR, "true");
  Object.assign(host.style, {
    position: "fixed",
    top: "0",
    left: "0",
    right: "0",
    bottom: "0",
    width: "100vw",
    height: "100dvh",
    zIndex: "2147483000",
    background: "#05060f",
    borderRadius: "0",
  });
  root.style.overflow = "hidden";
  document.body.style.overflow = "hidden";
  window.addEventListener("keydown", onKey);
}

function exitPseudo(): void {
  const s = pseudo;
  if (!s) return;
  pseudo = null;
  window.removeEventListener("keydown", s.onKey);
  s.host.removeAttribute(PSEUDO_FS_ATTR);
  if (s.hostStyle) s.host.setAttribute("style", s.hostStyle);
  else s.host.removeAttribute("style");
  for (const a of s.ancestors) {
    if (a.style) a.el.setAttribute("style", a.style);
    else a.el.removeAttribute("style");
  }
  document.documentElement.style.overflow = s.rootOverflow;
  document.body.style.overflow = s.bodyOverflow;
}

/** Enter or exit fullscreen on `host`. Never throws (a rejected native request is a no-op). */
export async function toggleHostFullscreen(host: HTMLElement | null): Promise<boolean> {
  if (!host || typeof document === "undefined") return false;
  if (pseudo?.host === host) {
    exitPseudo();
    emitChange();
    return false;
  }
  if (!nativeSupported(host)) {
    enterPseudo(host);
    emitChange();
    return true;
  }
  try {
    if (isHostFullscreen(host)) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else await (document as FsDocument).webkitExitFullscreen?.();
      return false;
    }
    if (host.requestFullscreen) await host.requestFullscreen();
    else await (host as FsElement).webkitRequestFullscreen?.();
    return true;
  } catch {
    return isHostFullscreen(host);
  }
}
