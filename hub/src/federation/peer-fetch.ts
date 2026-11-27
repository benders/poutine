// Outbound HTTP to a federation peer (#317).
//
// Every request whose URL comes from a peer (its registry `url`, an
// invitation's `inviter_url`, a handshake invitee's `url`) goes through
// `peerFetch`. It pins `redirect: "error"`: a 3xx answer rejects the
// promise instead of being followed. `checkPeerUrlSafe` vets only the URL we
// were given, so following a redirect would let the peer pick a different
// destination after the check — and the signed `x-poutine-*` headers would
// go with it.
//
// Peer-facing files are barred from the global `fetch` by lint
// (`hub/eslint.config.js`), so a new call site cannot skip this.

export type PeerFetchInit = Omit<RequestInit, "redirect">;

export function peerFetch(url: string, init: PeerFetchInit = {}): Promise<Response> {
  return fetch(url, { ...init, redirect: "error" });
}
