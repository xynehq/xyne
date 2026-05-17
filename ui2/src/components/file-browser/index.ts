// File-browser primitives. Feature-agnostic — any section that needs to
// browse a collection of folders + files (Knowledge, Custom Agents,
// attachments, …) composes these with its own data layer.

export { EntryGrid } from "./EntryGrid"
export { EntryList } from "./EntryList"
export { FileCard } from "./FileCard"
export { FolderCard } from "./FolderCard"
export { PathBreadcrumb } from "./PathBreadcrumb"
export { SearchField } from "./SearchField"
export { StatusBadge } from "./StatusBadge"
export { ViewToggle, type ViewMode } from "./ViewToggle"
export type {
  BrowserEntry,
  ColumnDef,
  EntryIndicator,
  FileEntry,
  FolderEntry,
  LeadingRenderer,
} from "./types"
