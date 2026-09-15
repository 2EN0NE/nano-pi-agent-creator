/**
 * 内联工具函数（源自 oh-my-pi `./util`，GPL-3.0）。
 *
 * 提供类型守卫与安全的字段提取，供引擎与扩展层共用。
 * 保持纯函数、零依赖，可独立单测。
 */

/** Narrow `unknown` to `Record<string, unknown>`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow `unknown` to `string`. */
export function isString(value: unknown): value is string {
	return typeof value === 'string';
}

/** Narrow `unknown` to a non-empty string. */
export function isNonEmptyString(value: unknown): value is string {
	return isString(value) && value.length > 0;
}

/** Narrow `unknown` to `number` (excludes NaN). */
export function isNumber(value: unknown): value is number {
	return typeof value === 'number' && !Number.isNaN(value);
}

/** Narrow `unknown` to `boolean`. */
export function isBoolean(value: unknown): value is boolean {
	return typeof value === 'boolean';
}

/** Narrow `unknown` to `readonly string[]`. */
export function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every(isString);
}

/** Higher-order guard: build a guard that checks every element of an array. */
export function isArrayOf<T>(
	guard: (item: unknown) => item is T,
): (value: unknown) => value is readonly T[] {
	return (value: unknown): value is readonly T[] => Array.isArray(value) && value.every(guard);
}

/** Extract a string field from a record safely (undefined if absent/not string). */
export function getStringField(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[key];
	return isString(field) ? field : undefined;
}

/** Extract a number field from a record safely (undefined if absent/not number). */
export function getNumberField(value: unknown, key: string): number | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[key];
	return isNumber(field) ? field : undefined;
}

/** Extract a boolean field from a record safely (undefined if absent/not boolean). */
export function getBooleanField(value: unknown, key: string): boolean | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[key];
	return isBoolean(field) ? field : undefined;
}

/** Extract a record field from a record safely (undefined if absent/not record). */
export function getRecordField(value: unknown, key: string): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[key];
	return isRecord(field) ? field : undefined;
}

/** Extract an array field from a record safely (undefined if absent/not array). */
export function getArrayField(value: unknown, key: string): unknown[] | undefined {
	if (!isRecord(value)) return undefined;
	const field = value[key];
	return Array.isArray(field) ? field : undefined;
}

/** Extract a human-readable message from an unknown error value. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

/** Narrow a readonly array to a non-empty readonly array. */
export function hasItems<T>(items: readonly T[]): items is NonEmptyReadonlyArray<T> {
	return items.length > 0;
}
