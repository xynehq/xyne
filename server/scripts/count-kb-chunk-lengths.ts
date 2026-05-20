// One-off stats job: scan every kb_items doc in Vespa and report how
// many chunks exceed the legacy snippet caps (800 / 1200 chars). We
// removed the truncation from the read path; this script answers
// "how often did the old caps actually fire on data we already
// ingested?"
//
// Usage (from repo root):
//   bun run server/scripts/count-kb-chunk-lengths.ts
//
// Streams via Vespa's /document/v1 visit API in pages of 1000. Only
// the `chunks` field is materialised — pos / embeddings stay on the
// server. Memory stays flat regardless of corpus size.
//
// Output: totals + buckets, plus a small per-doc histogram (max chunk
// length per doc) so we can tell whether long chunks are concentrated
// in a few docs or spread across the corpus.

import config, { NAMESPACE } from "@/config"

const SCHEMA = "kb_items"
const PAGE = 1000
const FIELD_SET = `${SCHEMA}:chunks`

type VisitResponse = {
  documents?: Array<{ id: string; fields?: { chunks?: string[] } }>
  continuation?: string
  documentCount?: number
}

async function main(): Promise<void> {
  const endpoint = config.vespaEndpoint.feedEndpoint
  let continuation: string | undefined
  let totalDocs = 0
  let totalChunks = 0
  let gt800 = 0
  let gt1200 = 0
  let docsWithAnyGt800 = 0
  let docsWithAnyGt1200 = 0
  // Coarse histogram on max-chunk-length per doc so we can see the
  // long-tail vs whole-corpus split.
  const docMaxBuckets = {
    "0-400": 0,
    "401-800": 0,
    "801-1200": 0,
    "1201-2000": 0,
    "2001+": 0,
  }

  const started = Date.now()
  let pages = 0
  while (true) {
    const params = new URLSearchParams({
      wantedDocumentCount: String(PAGE),
      fieldSet: FIELD_SET,
    })
    if (continuation) params.set("continuation", continuation)
    const url = `${endpoint}/document/v1/${NAMESPACE}/${SCHEMA}/docid?${params.toString()}`
    const res = await fetch(url)
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`visit failed ${res.status}: ${body.slice(0, 500)}`)
    }
    const body = (await res.json()) as VisitResponse
    const docs = body.documents ?? []
    pages++
    for (const d of docs) {
      totalDocs++
      const chunks = d.fields?.chunks ?? []
      let docHasGt800 = false
      let docHasGt1200 = false
      let maxLen = 0
      for (const c of chunks) {
        const len = c?.length ?? 0
        totalChunks++
        if (len > maxLen) maxLen = len
        if (len > 800) {
          gt800++
          docHasGt800 = true
        }
        if (len > 1200) {
          gt1200++
          docHasGt1200 = true
        }
      }
      if (docHasGt800) docsWithAnyGt800++
      if (docHasGt1200) docsWithAnyGt1200++
      if (maxLen <= 400) docMaxBuckets["0-400"]++
      else if (maxLen <= 800) docMaxBuckets["401-800"]++
      else if (maxLen <= 1200) docMaxBuckets["801-1200"]++
      else if (maxLen <= 2000) docMaxBuckets["1201-2000"]++
      else docMaxBuckets["2001+"]++
    }
    if (pages % 5 === 0) {
      // eslint-disable-next-line no-console
      console.log(
        `  …visited ${totalDocs} docs, ${totalChunks} chunks (page ${pages})`,
      )
    }
    if (!body.continuation) break
    continuation = body.continuation
  }
  const elapsedMs = Date.now() - started

  // eslint-disable-next-line no-console
  console.log("")
  // eslint-disable-next-line no-console
  console.log(`kb_items chunk-length report`)
  // eslint-disable-next-line no-console
  console.log(`  endpoint   : ${endpoint}`)
  // eslint-disable-next-line no-console
  console.log(`  namespace  : ${NAMESPACE}`)
  // eslint-disable-next-line no-console
  console.log(`  elapsed    : ${(elapsedMs / 1000).toFixed(1)}s`)
  // eslint-disable-next-line no-console
  console.log(`  documents  : ${totalDocs}`)
  // eslint-disable-next-line no-console
  console.log(`  chunks     : ${totalChunks}`)
  // eslint-disable-next-line no-console
  console.log("")
  // eslint-disable-next-line no-console
  console.log(`  chunks  > 800 chars : ${gt800}`)
  // eslint-disable-next-line no-console
  console.log(`  chunks  >1200 chars : ${gt1200}`)
  // eslint-disable-next-line no-console
  console.log(`  docs   with any > 800  : ${docsWithAnyGt800}`)
  // eslint-disable-next-line no-console
  console.log(`  docs   with any >1200  : ${docsWithAnyGt1200}`)
  // eslint-disable-next-line no-console
  console.log("")
  // eslint-disable-next-line no-console
  console.log(`  per-doc max-chunk-length distribution:`)
  for (const [bucket, count] of Object.entries(docMaxBuckets)) {
    // eslint-disable-next-line no-console
    console.log(`    ${bucket.padEnd(10)} ${count}`)
  }
}

main().catch((err): void => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
