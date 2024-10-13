import { Apps, AuthType, Entity } from "shared/types"
import { z } from "zod"

export const searchSchema = z.object({
  query: z.string(),
  groupCount: z
    .union([z.string(), z.undefined(), z.null()])
    .transform((x) => (x ? x === "true" : false))
    .pipe(z.boolean())
    .optional(),
  offset: z
    .union([z.string(), z.undefined(), z.number(), z.null()])
    .transform((x) => Number(x ?? 0))
    .pipe(z.number().min(0))
    .optional(),
  // removed min page size for filters
  page: z
    .union([z.string(), z.undefined(), z.number(), z.null()])
    .transform((x) => Number(x ?? 8))
    .pipe(z.number())
    .optional(),
  app: z.string().min(1).optional(),
  entity: z.string().min(1).optional(),
})

export type Connectors = {
  app: string
  status: string
  authType: AuthType
}

export type Groups = Record<Apps, Record<Entity, number>>
