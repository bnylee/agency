/**
 * The one thing the browser needs to know about the generated Obsidian vault.
 *
 * Kept in its own module rather than inlined in the panel because the *name* of
 * the vault is a contract between three things that cannot see each other: the
 * folder `scripts/build-vault.ts` writes, the vault Obsidian has registered, and
 * the `obsidian://` URI this constructs. If they disagree the link silently does
 * nothing, which is the worst failure mode available to a hyperlink.
 */

/** Folder name under the Agency root, and therefore Obsidian's vault name. */
export const VAULT_DIR = "vault";

/**
 * A URI that opens one note in Obsidian.
 *
 * `obsidian://open?vault=<name>&file=<path>` resolves against vaults Obsidian
 * already knows about — it cannot register one. So this works only after the
 * folder has been opened once via "Open folder as vault", and there is no way to
 * detect that from a web page: the protocol handler either fires or it does not,
 * and the browser reports nothing either way. The panel says so in as many words
 * rather than offering a link that looks broken.
 */
export function obsidianUri(noteRelPath: string): string {
  return `obsidian://open?vault=${encodeURIComponent(VAULT_DIR)}&file=${encodeURIComponent(noteRelPath)}`;
}
