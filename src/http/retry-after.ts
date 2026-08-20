/**
 * Reads a `Retry-After` header as a delay in milliseconds.
 *
 * Both forms in the specification are accepted: delta-seconds, and an
 * HTTP-date, which is turned into a delay by subtracting `now`. A missing,
 * malformed or already-past value is `undefined`, because a header nobody can
 * parse should not become a wait nobody asked for.
 */
export function parseRetryAfter(
	value: string | null | undefined,
	now: number
): number | undefined {
	if (!value) {
		return undefined;
	}

	const header = value.trim();

	if (/^\d+$/.test(header)) {
		return Number(header) * 1000;
	}

	const date = Date.parse(header);

	if (Number.isNaN(date)) {
		return undefined;
	}

	return Math.max(0, date - now);
}
