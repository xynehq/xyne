import type { Context, ValidationTargets } from "hono"
import {
  autocomplete,
  deduplicateAutocomplete,
  groupVespaSearch,
  searchVespa,
  type AppEntityCounts,
} from "@/search/vespa"
import { z } from "zod"
import config from "@/config"
import { HTTPException } from "hono/http-exception"
import {
  Apps,
  GooglePeopleEntity,
  type VespaSearchResponse,
} from "@/search/types"
import {
  VespaAutocompleteResponseToResult,
  VespaSearchResponseToSearchResult,
} from "@/search/mappers"
import { askQuestion } from "@/ai/provider/bedrock"
import { answerContextMap } from "@/ai/context"
import { VespaSearchResultsSchema } from "@/search/types"
import { AnswerSSEEvents } from "@/shared/types"
import { streamSSE } from "hono/streaming"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
const Logger = getLogger(Subsystem.Api)

const { JwtPayloadKey } = config

export const autocompleteSchema = z.object({
  query: z.string().min(2),
})

export const AutocompleteApi = async (c: Context) => {
  try {
    const { sub } = c.get(JwtPayloadKey)
    const email = sub
    // @ts-ignore
    const body = c.req.valid("json")
    const { query } = body
    let results = await autocomplete(query, email, 5)
    if (!results) {
      return c.json({ children: [] })
    }
    results = deduplicateAutocomplete(results)
    const newResults = VespaAutocompleteResponseToResult(results)
    return c.json(newResults)
  } catch (e) {
    console.error(e)
    throw new HTTPException(500, {
      message: "Could not fetch autocomplete results",
    })
  }
}

export const SearchApi = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  const email = sub
  let {
    query,
    groupCount: gc,
    offset,
    page,
    app,
    entity,
    // @ts-ignore
  } = c.req.valid("query")
  let groupCount: any = {}
  let results: VespaSearchResponse = {} as VespaSearchResponse
  const decodedQuery = decodeURIComponent(query)
  if (gc) {
    groupCount = await groupVespaSearch(query, email)
    results = await searchVespa(decodedQuery, email, app, entity, page, offset)
  } else {
    results = await searchVespa(decodedQuery, email, app, entity, page, offset)
  }

  // TODO: deduplicate for google admin and contacts
  const newResults = VespaSearchResponseToSearchResult(results)
  newResults.groupCount = groupCount
  return c.json(newResults)
}

export const AnswerApi = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  const email = sub
  // @ts-ignore
  const { query, app, entity } = c.req.valid("query")
  const decodedQuery = decodeURIComponent(query)
  let results: VespaSearchResponse = await searchVespa(
    decodedQuery,
    email,
    app,
    entity,
    config.page,
    0,
  )

  return streamSSE(c, async (stream) => {
    // Stream the initial context information
    await stream.writeSSE({
      data: `Starting response for query: ${query}`,
      event: AnswerSSEEvents.Start,
    })

    const contextData = results.root.children
      .map(
        (v, i) =>
          `Index ${i} \n ${answerContextMap(v as z.infer<typeof VespaSearchResultsSchema>)}`,
      )
      .join("\n\n")

    await askQuestion(
      `Based on this context from search engine ${contextData}. Only use the relevant chunks, ignore the rest. Answer if it is a question or summarize. Do not give any unnecessary details. Also respond with the index of the chunk that helped you answer the query the most. ${query}`,
      { temperature: 0 },
      async (chunk) => {
        await stream.writeSSE({
          data: chunk,
          event: AnswerSSEEvents.AnswerUpdate,
        })
      },
    )

    await stream.writeSSE({
      data: "Answer complete",
      event: AnswerSSEEvents.End,
    })

    stream.onAbort(() => {
      Logger.error("SSE stream aborted")
    })
  })
}

// temporaryly pausing this since contact is a
// separate data source it does make sense for to be separate
//
// const postProcess = (
//   resp: VespaSearchResponse,
//   groupCount: AppEntityCounts,
// ): VespaSearchResponse => {
//   const { root } = resp
//   if (!root.children) {
//     return resp
//   }
//   // if group data is available it will be
//   // more performant to pre-check
//   if (groupCount) {
//     // first drive and workspace data both has to be present
//     if (!(groupCount[Apps.GoogleDrive] && groupCount[Apps.GoogleWorkspace])) {
//       return resp
//     }
//     if (
//       !(
//         (groupCount[Apps.GoogleDrive][GooglePeopleEntity.Contacts] ||
//           groupCount[Apps.GoogleDrive][GooglePeopleEntity.OtherContacts]) &&
//         groupCount[Apps.GoogleWorkspace][GooglePeopleEntity.AdminDirectory]
//       )
//     ) {
//       return resp
//     }
//     // we have to manage the group counts ourself now
//     // one issue here is that you can give incorrect counts
//     // because for this page we are deduplicating
//     // but if next few pages has duplicates then the count will
//     // be shown more than the results we send back
//     const uniqueResults = []
//     const emails = new Set()
//     for (const child of root.children) {
//       // @ts-ignore
//       const email = child.fields.email
//       if (email && !emails.has(email)) {
//         emails.add(email)
//         uniqueResults.push(child)
//       } else if (!email) {
//         uniqueResults.push(child)
//       }
//     }
//   }
// }
