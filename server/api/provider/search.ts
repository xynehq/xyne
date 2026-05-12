import { type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import config, { NAMESPACE, CLUSTER } from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Server)

/**
 * Build a Vespa filter expression implementing two-layer access control.
 *
 * - visibility = "public"  →  always visible
 * - visibility = "authenticated" with NO access_tags  →  any authenticated user
 * - visibility = "authenticated" with access_tags  →  only users with a matching tag
 */
export function buildVisibilityFilter(
  isAuthenticated: boolean,
  userTags: string[],
): string {
  // Public docs are always visible
  const clauses: string[] = [`visibility = "public"`]

  if (isAuthenticated) {
    // Authenticated docs with no access_tags → visible to any authenticated user
    // Vespa: access_tags is empty when its count is 0; we approximate with
    // "NOT access_tags matches anything meaningful" — but Vespa doesn't support
    // isEmpty natively on arrays. Instead we use a two-pronged approach:
    //   1. Docs with empty access_tags: we tag them with a sentinel "__all_authenticated__" at ingestion
    //   2. Docs with specific tags: match against user's tags
    const tagClauses = userTags
      .map((tag) => `access_tags contains "${tag}"`)
      .join(" OR ")

    const authenticatedFilter = tagClauses
      ? `visibility = "authenticated" AND (access_tags contains "__all_authenticated__" OR ${tagClauses})`
      : `visibility = "authenticated" AND access_tags contains "__all_authenticated__"`

    clauses.push(`(${authenticatedFilter})`)
  }

  return clauses.join(" OR ")
}

export const ProviderSearchApi = async (c: Context) => {
  const { query, max_results } = c.req.valid("json" as never)
  const accessTags = c.get("accessTags") as string[]
  const isAuthenticated = c.get("isAuthenticated") as boolean
  const workspaceId = c.get("workspaceId") as string

  try {
    const hits = (max_results as number) ?? 10

    // Two-layer access control:
    // Layer 1 (visibility): public docs are always visible; authenticated docs require auth
    // Layer 2 (access_tags): if an authenticated doc has tags, user must have a matching tag
    const visibilityFilter = buildVisibilityFilter(isAuthenticated, accessTags)
    const yql = `select * from kb_items where userInput(@query) AND (${visibilityFilter})`

    const vespaQuery = {
      yql,
      query,
      hits,
      offset: 0,
      "ranking.profile": "default_ai",
      "ranking.features.query(alpha)": 0.5,
      "input.query(e)": `embed(${query})`,
      "presentation.summary": "default",
    }

    const response = await fetch(
      `${config.vespaEndpoint.queryEndpoint}/search/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vespaQuery),
      },
    )

    if (!response.ok) {
      const errorText = await response.text()
      Logger.error(
        { status: response.status, body: errorText },
        "Vespa search failed for provider",
      )
      throw new HTTPException(502, { message: "Search service unavailable" })
    }

    const vespaResult = (await response.json()) as {
      root?: {
        children?: Array<{
          id?: string
          relevance?: number
          fields?: Record<string, unknown>
        }>
      }
    }

    // Format response to match SDK client contract
    const results =
      vespaResult.root?.children?.map((hit) => ({
        docId: hit.fields?.docId as string,
        title: hit.fields?.fileName as string,
        score: hit.relevance ?? 0,
        content:
          (hit.fields?.chunks as string[])?.join("\n") ?? "",
        sourceUrl: (hit.fields?.storagePath as string) ?? undefined,
      })) ?? []

    return c.json({ results })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Provider search failed")
    throw new HTTPException(500, { message: "Search failed" })
  }
}
