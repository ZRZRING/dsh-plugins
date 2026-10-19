/**
 * Host half of the edit/continue bundle.
 *
 * The capability is entirely browser-side: the Client bundle registers two
 * slot entries (a user-message renderer with an inline editor and a Continue
 * button beside Send). This row exists so the Loader entry carries the
 * package's `dsh.client` declaration and the Client Modules registry can serve
 * `client.js` to the page.
 */
export function apply() {}
