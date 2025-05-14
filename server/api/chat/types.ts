import { Apps } from "@/shared/types"
import { entitySchema } from "@/search/types"
import { z } from "zod"

const MinimalCitationSchema = z.object({
  docId: z.string(),
  title: z.string().optional(),
  url: z.string().optional(),
  app: z.nativeEnum(Apps),
  entity: entitySchema,
})

export type Citation = z.infer<typeof MinimalCitationSchema>
