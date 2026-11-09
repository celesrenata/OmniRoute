/**
 * Fullscreen helpers for the Atomic scene host (operator directive 35). Pure DOM,
 * no `three`. The host element (canvas + labels + detail panel + legend) is the
 * fullscreen target, so everything goes fullscreen together. The Escape key exits
 * natively (browser-owned).
 */
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
/** True when the host can enter fullscreen (false on iOS Safari non-video elements, jsdom, SSR). */
export function fullscreenSupported(host: HTMLElement | null): boolean {
  if (!host || typeof document === "undefined") return false;
  if (document.fullscreenEnabled === false) return false;
  return (
    typeof host.requestFullscreen === "function" ||
    typeof (host as FsElement).webkitRequestFullscreen === "function"
  );
}
/** True while `host` is the fullscreen element. */
export function isHostFullscreen(host: HTMLElement | null): boolean {
  if (!host || typeof document === "undefined") return false;
  const el = document.fullscreenElement ?? (document as FsDocument).webkitFullscreenElement;
  return el === host;
}
/** Enter or exit fullscreen on `host`. Never throws (a rejected request is a no-op). */
export async function toggleHostFullscreen(host: HTMLElement | null): Promise<boolean> {
  if (!host || typeof document === "undefined") return false;
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
