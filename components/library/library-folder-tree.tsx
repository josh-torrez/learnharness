"use client";

import { useState, type DragEvent, type ReactNode } from "react";
import { FolderIcon, FolderOpenIcon } from "lucide-react";
import { canMoveFolder, folderIsEmpty, fuzzyScore, placementOf, folderEntryCheck, type SourceEntrySelection, type SourceDirectory } from "@/src/core";
import type { ChainSort } from "@/components/chain-table";
import { chainRow } from "@/components/chain-navigation";
import { TreeCell, TreeCheckbox, TreeDisclosure, TreeGuide, TreeSeparator, treeBranchLayout, treeRowLayout } from "@/components/tree-presentation";
import { EditableSourceName, SourceDragRow, type OrganizationChange } from "@/components/source-folder-tree";

/**
 * THE LIBRARY'S FOLDER TREE (owner ruling, upstream v0.6 merge): a copy of
 * upstream's SourceFolderTree (components/source-folder-tree.tsx) plus the
 * Library page's opt-ins — row-click/Shift/Cmd selection, folder
 * double-click, toolbar-driven rename and hidden folder checkboxes. Upstream's
 * tree stays exactly upstream's; re-sync this copy when theirs changes.
 * Drags still come from upstream's SourceDragRow, so the drag type matches.
 */
const DRAG_TYPE = "application/x-learnharness-source";

/** Clicks on a row's own controls (checkbox, rename, expander, links) keep
 *  their behavior and never count as a row click. */
export function isRowControlClick(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest('input,button,a,textarea,select,[contenteditable="true"]') !== null;
}

/** How a row click selects (the Library page): plain = only this row,
 *  Cmd/Ctrl = add/remove it, Shift = the range from the anchor. */
export type RowClickMode = "only" | "toggle" | "range";
export function rowClickMode(event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): RowClickMode {
	return event.shiftKey ? "range" : event.metaKey || event.ctrlKey ? "toggle" : "only";
}

/** Source/folder names are also searchable, including sources without nodes. */
interface TreeSource {
	key: string; birth: string | null; label: string | null; nodeIds: string[]; newestCreatedAt: string;
}
export function LibraryFolderTree<T extends TreeSource>({ groups, directory, query, sort, renderSource, onAction, expanded,
	onToggleExpanded, selection, selectedFolders, onToggleNodes, onToggleFolder, onSelectFolderRow, onFolderRowDoubleClick, folderRename, hideFolderCheckbox = false, allSourceNodes, allowEmptySelection = true, collapsedForSearch, sourceSelection }: {
	groups: T[]; directory?: SourceDirectory; query: string; sort: ChainSort;
	renderSource: (source: T, depth: number) => ReactNode;
	allSourceNodes?: ReadonlyMap<string, ReadonlySet<string>>;
	allowEmptySelection?: boolean;
	collapsedForSearch?: ReadonlySet<string>;
	sourceSelection?: SourceEntrySelection;
	onAction?: OrganizationChange; expanded: ReadonlySet<string>; onToggleExpanded: (id: string) => void;
	selection: ReadonlySet<string>; selectedFolders: ReadonlySet<string>;
	onToggleNodes: (ids: string[], next: boolean) => void; onToggleFolder: (id: string, next: boolean) => void;
	/** Opt-in (the Library page): a click on the folder row outside its
	 *  checkbox, expander, icon and name selects only that folder. */
	onSelectFolderRow?: (id: string, mode: RowClickMode) => void;
	/** After a folder row double-click (which expands/collapses it). */
	onFolderRowDoubleClick?: (id: string) => void;
	/** Opt-in (the Library page): folder names are plain text and rename only
	 *  when an outside control (the toolbar) names the folder in `id`. */
	folderRename?: { id: string | null; onDone: () => void };
	/** Opt-in (the Library page): no folder checkboxes; the row highlight
	 *  alone shows selection. */
	hideFolderCheckbox?: boolean;
}) {
	const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined);
	const [draggedItem, setDraggedItem] = useState<{ kind: "source" | "folder"; id: string }>();
	if (!directory) return <>{groups.map((g) => renderSource(g, 0))}</>;
	const state = directory.organization;
	const ids = new Set(directory.sources.map((s) => s.id));
	const search = query.trim() !== "";
	const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
	const parentOf = (g: Pick<T, "birth">) => g.birth === null ? null : placementOf(state, g.birth)?.folderId ?? null;
	const isDescendant = (g: Pick<T, "birth">, folderId: string): boolean => {
		let parent = parentOf(g);
		while (parent !== null) {
			if (parent === folderId) return true;
			parent = state.folders.find((f) => f.id === parent)?.parentId ?? null;
		}
		return false;
	};
	const nodeIds = (folderId: string) => [...new Set(allSourceNodes
		? [...allSourceNodes].filter(([birth]) => isDescendant({ birth }, folderId)).flatMap(([, nodes]) => [...nodes])
		: groups.filter((g) => isDescendant(g, folderId)).flatMap((g) => g.nodeIds))];
	const visibleFolder = (id: string): boolean => !search || groups.some((g) => isDescendant(g, id))
		|| state.folders.some((f) => f.id === id && fuzzyScore(query, f.name) !== null)
		|| state.folders.some((f) => f.parentId === id && visibleFolder(f.id));
	const dropProps = (parentId: string | null) => onAction ? {
		onDragOver(event: DragEvent) {
			if (!Array.from(event.dataTransfer.types).includes(DRAG_TYPE)) return;
			event.preventDefault(); event.stopPropagation();
			const valid = draggedItem?.kind !== "folder" || canMoveFolder(state, draggedItem.id, parentId);
			event.dataTransfer.dropEffect = valid ? "move" : "none";
			setDropTarget(valid ? parentId : undefined);
		},
		onDragLeave(event: DragEvent) {
			if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
			event.stopPropagation();
			setDropTarget((previous) => previous === parentId ? undefined : previous);
		},
		onDrop(event: DragEvent) {
			const raw = event.dataTransfer.getData(DRAG_TYPE);
			if (!raw) return;
			event.preventDefault(); event.stopPropagation();
			setDropTarget(undefined); setDraggedItem(undefined);
			let item: { kind?: unknown; id?: unknown };
			try { item = JSON.parse(raw); } catch { return; }
			if (!item || typeof item !== "object") return;
			if ((item.kind !== "source" && item.kind !== "folder") || typeof item.id !== "string") return;
			if (item.kind === "folder" && !canMoveFolder(state, item.id, parentId)) return;
			void onAction({ action: "move", kind: item.kind, id: item.id, parentId }).catch(() => {});
		},
	} : {};
	const renderLevel = (parentId: string | null, depth: number): ReactNode => {
		const items = [
			...groups.filter((g) => parentOf(g) === parentId).map((g) => ({ kind: "source" as const, source: g, id: g.key, name: g.label ?? "\uffff", count: g.nodeIds.length, date: g.newestCreatedAt })),
			...state.folders.filter((f) => f.parentId === parentId && visibleFolder(f.id)).map((f) => ({ kind: "folder" as const, folder: f, id: f.id, name: f.name, count: nodeIds(f.id).length, date: f.createdAt })),
		];
		items.sort((a, b) => {
			const byName = collator.compare(a.name, b.name);
			return (sort.col === "name" ? byName : sort.col === "props" ? a.count - b.count : a.date.localeCompare(b.date)) * sort.dir || byName || a.id.localeCompare(b.id);
		});
		return items.map((item) => {
			if (item.kind === "source") return <div key={item.id} {...dropProps(parentId)}>{renderSource(item.source, depth)}</div>;
			const folder = item.folder;
			const open = search ? !collapsedForSearch?.has(folder.id) : expanded.has(folder.id);
			const members = nodeIds(folder.id);
			const empty = folderIsEmpty(state, folder.id, ids);
			const selectedCount = members.filter((id) => selection.has(id)).length;
			const entryCheck = sourceSelection ? folderEntryCheck(directory, folder.id, sourceSelection) : undefined;
			const hasChildren = state.folders.some((f) => f.parentId === folder.id && visibleFolder(f.id)) || groups.some((g) => parentOf(g) === folder.id);
			const rowSelected = Boolean(onSelectFolderRow && entryCheck?.checked);
			return <div key={folder.id} data-testid={`source-folder-${folder.id}`} {...treeBranchLayout()} {...dropProps(folder.id)}>
				<SourceDragRow {...chainRow(["folder", folder.id], depth, open)} kind="folder" id={folder.id} name={folder.name} enabled={Boolean(onAction)} data-testid={`folder-row-${folder.id}`}
					data-drop-active={dropTarget === folder.id}
					data-selected={rowSelected || undefined}
					{...treeRowLayout({ depth, className: `transition-colors ${!open || !hasChildren ? "border-b border-transparent" : ""} ${onSelectFolderRow ? "cursor-pointer outline-none hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring" : ""} ${dropTarget === folder.id ? "bg-accent/50" : rowSelected ? "bg-primary/10" : ""}`, style: { paddingLeft: 12 + depth * 36 } })}
					onMouseDown={onSelectFolderRow ? (e) => { if (e.shiftKey && !isRowControlClick(e.target)) e.preventDefault(); } : undefined}
					onClick={onSelectFolderRow ? (e) => { if (e.detail <= 1 && !isRowControlClick(e.target)) onSelectFolderRow(folder.id, rowClickMode(e)); } : undefined}
					onDoubleClick={onSelectFolderRow ? (e) => { if (!isRowControlClick(e.target)) { onToggleExpanded(folder.id); onFolderRowDoubleClick?.(folder.id); } } : undefined}>
					{!hideFolderCheckbox && <TreeCheckbox aria-label={`Select ${sourceSelection ? "folder" : "contents of"} ${folder.name}`} data-testid={`folder-checkbox-${folder.id}`}
						disabled={entryCheck ? false : empty ? !allowEmptySelection : members.length === 0}
						checked={entryCheck?.checked ?? (empty ? selectedFolders.has(folder.id) : members.length > 0 && selectedCount === members.length)}
						indeterminate={entryCheck?.indeterminate ?? (!empty && selectedCount > 0 && selectedCount < members.length)}
						onChange={(e) => { if (entryCheck || empty) onToggleFolder(folder.id, e.target.checked); else onToggleNodes(members, e.target.checked); }} />}
					<TreeDisclosure plain open={open} aria-label={`Expand folder ${folder.name}`} data-testid={`folder-toggle-${folder.id}`}
						onClick={() => onToggleExpanded(folder.id)} />
					<button type="button" data-source-icon data-testid={`folder-icon-${folder.id}`} aria-expanded={open} aria-label={`Expand folder ${folder.name}`}
						onClick={() => onToggleExpanded(folder.id)} className="flex h-5 w-3.5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
						{open ? <FolderOpenIcon className="size-3.5 shrink-0" /> : <FolderIcon className="size-3.5 shrink-0" />}
					</button>
					{onAction && folderRename?.id === folder.id
						? <EditableSourceName name={folder.name} initiallyEditing onCancel={folderRename.onDone}
							onSave={async (name) => { if (name !== folder.name) await onAction({ action: "rename-folder", id: folder.id, name }); folderRename.onDone(); }} />
						: onAction && !folderRename ? <EditableSourceName name={folder.name} onSave={(name) => onAction({ action: "rename-folder", id: folder.id, name })} />
						: <span className="min-w-0 flex-1 truncate text-sm font-medium">{folder.name}</span>}
					<TreeCell widthClassName="w-14" align="right" className="text-xs tabular-nums text-muted-foreground">{members.length}</TreeCell>
					<TreeCell widthClassName="w-20" align="right" className="text-xs tabular-nums text-muted-foreground">{folder.createdAt.slice(0, 10)}</TreeCell>
				</SourceDragRow>
				{open && hasChildren && <TreeGuide selectionColumn depth={depth} data-testid={`folder-thread-${folder.id}`} />}
				{open && renderLevel(folder.id, depth + 1)}
				<TreeSeparator data-testid={`folder-separator-${folder.id}`} inset={depth === 0 ? 0 : depth * 36 + 1} />
			</div>;
		});
	};
	return <div className="flex flex-1 flex-col" onDragStart={(event) => {
		try {
			const item = JSON.parse(event.dataTransfer.getData(DRAG_TYPE));
			if (item && (item.kind === "source" || item.kind === "folder") && typeof item.id === "string") setDraggedItem(item);
		} catch { /* An unrelated native text/file drag is not an organization move. */ }
	}} onDragEnd={() => { setDropTarget(undefined); setDraggedItem(undefined); }}>
		<div>{renderLevel(null, 0)}</div>
		{onAction && <div data-testid="source-root-drop" aria-label="Move outside folders" data-drop-active={dropTarget === null}
			className={`min-h-16 flex-1 transition-colors ${dropTarget === null ? "bg-accent/30" : ""}`} {...dropProps(null)} />}
	</div>;
}
