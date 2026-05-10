import { type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import config, { NAMESPACE, CLUSTER } from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Server)

export const ProviderSearchApi = async (c: Context) => {
  const { query, max_results } = c.req.valid("json" as never)
  const accessTags = c.get("accessTags") as string[]
  const workspaceId = c.get("workspaceId") as string

  if (!accessTags || accessTags.length === 0) {
    return c.json({ results: [] })
  }

  try {
    const hits = (max_results as number) ?? 10

    // Build access_tags filter: access_tags contains "tag1" OR access_tags contains "tag2" ...
    const tagFilters = accessTags
      .map((tag: string) => `access_tags contains "${tag}"`)
      .join(" OR ")
    const yql = `select * from kb_items where userInput(@query) AND (${tagFilters})`

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
