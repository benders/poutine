/**
 * Thin wrapper around `window.location.reload()` so update-flow code (#196)
 * can be unit-tested — jsdom's location.reload is non-configurable and
 * throws "Not implemented: navigation", so tests mock this module instead.
 */
export function reloadPage(): void {
  window.location.reload();
}
