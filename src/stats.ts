/**
 * Statistical primitives backed by jStat (the project's one numeric dependency).
 *
 * jStat is wrapped here behind a typed boundary so the rest of the codebase
 * never touches the untyped package directly. We use it for the two things that
 * are genuinely awkward to hand-roll correctly: Pearson correlation and the
 * Student-t CDF used to turn an r into a two-tailed p-value. Descriptive stats
 * (mean/sd/median/…) live in signal.ts because they must skip nulls inline.
 */

import jstatPkg from "jstat";

// The default export is the namespace under both CJS and ESM interop, but some
// bundles nest it under `.jStat`. Normalise once.
const jStat = jstatPkg.jStat ?? jstatPkg;

export interface PearsonResult {
	/** Number of paired, non-null samples actually used. */
	n: number;
	/** Pearson correlation coefficient, or null if it could not be computed. */
	r: number | null;
	/** Two-tailed p-value for H0: r = 0, or null if not computable. */
	p: number | null;
}

/**
 * Pearson r and its two-tailed p-value over the paired non-null samples of two
 * equally-indexed series. Samples where either side is null/non-finite are
 * dropped pairwise. Requires at least 3 valid pairs.
 */
export function pearson(a: (number | null)[], b: (number | null)[]): PearsonResult {
	const xs: number[] = [];
	const ys: number[] = [];
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const x = a[i];
		const y = b[i];
		if (x != null && y != null && Number.isFinite(x) && Number.isFinite(y)) {
			xs.push(x);
			ys.push(y);
		}
	}
	const n = xs.length;
	if (n < 3) return { n, r: null, p: null };

	let r = jStat.corrcoeff(xs, ys);
	if (!Number.isFinite(r)) return { n, r: null, p: null };
	if (r > 1) r = 1;
	if (r < -1) r = -1;

	let p: number;
	if (Math.abs(r) >= 1) {
		p = 0;
	} else {
		const t = r * Math.sqrt((n - 2) / (1 - r * r));
		p = 2 * (1 - jStat.studentt.cdf(Math.abs(t), n - 2));
		if (p < 0) p = 0;
		if (p > 1) p = 1;
	}
	return { n, r, p };
}
