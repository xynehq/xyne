// File-browser primitives. Feature-agnostic — any section that needs to
// browse a collection of folders + files (Knowledge, Custom Agents,
// attachments, …) composes these with its own data layer.

export { EntryGrid } from "./EntryGrid"
export { EntryList } from "./EntryList"
export { FileCard, type FileFormat } from "./FileCard"
export { FolderCard } from "./FolderCard"
export { IngestStatusIndicator } from "./IngestStatusIndicator"
export { PathBreadcrumb } from "./PathBreadcrumb"
export { SearchField } from "./SearchField"
export { ViewToggle, type ViewMode } from "./ViewToggle"
export type {
  BrowserEntry,
  ColumnDef,
  FileEntry,
  FolderEntry,
  LeadingRenderer,
} from "./types"
