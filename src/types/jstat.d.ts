/**
 * Minimal ambient declaration for the `jstat` package, which ships no types.
 * We use only a small slice of its API (Pearson correlation + the Student-t
 * CDF for p-values); the rest is intentionally omitted. The runtime default
 * export is sometimes the namespace itself and sometimes `{ jStat }` depending
 * on the module system, so both shapes are typed (see src/stats.ts).
 */
declare module "jstat" {
	interface JStat {
		corrcoeff(a: number[], b: number[]): number;
		mean(a: number[]): number;
		median(a: number[]): number;
		stdev(a: number[], sample?: boolean): number;
		studentt: { cdf(x: number, dof: number): number };
	}
	const j: JStat & { jStat?: JStat };
	export default j;
}
