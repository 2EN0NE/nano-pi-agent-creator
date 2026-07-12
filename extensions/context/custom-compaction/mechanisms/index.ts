/**
 * Compaction Mechanism Adapter Registry
 *
 * External compaction mechanisms register themselves here.
 * Each adapter is a file in mechanisms/ that wraps an external compaction approach.
 *
 * Usage:
 *   registerAdapter({
 *     id: "my_compact",
 *     name: "My Compact Method",
 *     description: "Does XYZ during compaction",
 *     beforeCompact: async (ctx, profile) => { ...; return true; },
 *   });
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { CompactionProfile } from "../types.js";

// ── Adapter interface ───────────────────────────────────────────

export interface CompactionAdapter {
	/** Unique ID referenced in CompactionMechanism.adapterId */
	id: string;
	/** Human-readable name for the settings panel */
	name: string;
	/** Short description */
	description: string;
	/**
	 * Called at extension setup time.
	 * Adapter can register event handlers or tools here.
	 */
	register?: (pi: ExtensionAPI) => void;
	/**
	 * Called in session_before_compact.
	 * Return true  → adapter handled the compaction (skip default summarize behavior).
	 * Return false → fall through (may be picked up by another extension or default).
	 */
	beforeCompact?: (
		ctx: ExtensionContext,
		profile: CompactionProfile,
	) => Promise<boolean>;
}

// ── Registry ────────────────────────────────────────────────────

const _adapters = new Map<string, CompactionAdapter>();

/**
 * Register a compaction mechanism adapter.
 * Silently ignores duplicate registrations with the same ID (first wins).
 */
export function registerAdapter(adapter: CompactionAdapter): void {
	if (_adapters.has(adapter.id)) {
		// Already registered (e.g. if this module is hot-reloaded)
		return;
	}
	_adapters.set(adapter.id, adapter);
}

/**
 * Get a registered adapter by ID.
 */
export function getAdapter(id: string): CompactionAdapter | undefined {
	return _adapters.get(id);
}

/**
 * Get all registered adapters.
 */
export function getAllAdapters(): CompactionAdapter[] {
	return Array.from(_adapters.values());
}

/**
 * Check if a given adapter ID is registered.
 */
export function hasAdapter(id: string): boolean {
	return _adapters.has(id);
}
