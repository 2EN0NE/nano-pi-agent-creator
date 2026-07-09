/** Resource categories for startup display */
export type ResourceType = "context" | "skill" | "extension" | "theme";

export interface ResourceItem {
	name: string;
	type: ResourceType;
	sourceLabel: string;
	path: string;
}

/** Minimal skill info used by the widget */
export interface SkillEntry {
	name: string;
	filePath: string;
	sourceInfo?: { source?: string; scope?: string };
}

/** Context file info */
export interface ContextFileEntry {
	path: string;
	content: string;
}

/** Widget display mode */
export type CollapseMode = "collapsed" | "expanded";
