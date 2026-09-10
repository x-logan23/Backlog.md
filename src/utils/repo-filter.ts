/**
 * Normalize a `repo` value for comparison.
 *
 * Trims, drops surrounding slashes and lowercases, so "payments-api",
 * "payments-api/" and "Payments-API" all match the same repository. Used for
 * filtering only — the stored value is kept verbatim, and the dispatcher is
 * what resolves it to a directory.
 */
export function normalizeRepoValue(value: string): string {
	return value
		.trim()
		.replace(/^\/+|\/+$/g, "")
		.toLowerCase();
}
