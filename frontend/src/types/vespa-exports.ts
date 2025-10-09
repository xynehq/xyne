// Re-export types from server for frontend use
export type {
  FileSchema,
  VespaFile,
  VespaFileWithDrivePermission,
} from "../../../server/node_modules/@xyne/vespa-ts/dist/src/types"

// You can now import like: import { FileSchema } from "@/types/vespa-exports";
