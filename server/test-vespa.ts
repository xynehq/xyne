import { GetDocumentsByDocIds } from "./search/vespa"

async function run() {
  const mockSpan = {
    setAttribute: () => mockSpan,
    addEvent: () => mockSpan,
    end: () => mockSpan,
    startSpan: () => mockSpan,
  };
  const docId = "clf-hj02vxjzsnkukyav06u1uo8d";
  const result = await GetDocumentsByDocIds([docId], mockSpan as any);
  if (result?.root?.children?.[0]) {
    const fields = result.root.children[0].fields as any;
    console.log("Fields present:", Object.keys(fields));
    console.log("Has chunks_map:", !!fields.chunks_map);
    if (!fields.chunks_map) {
      console.log("Chunk map is missing. What fields DO we have?", fields);
    }
    console.log("Is chunks_summary an array?", Array.isArray(fields.chunks_summary));
    console.log("Length of chunks_summary:", fields.chunks_summary?.length);
    if (fields.chunks_summary?.length) {
      console.log("First chunk:", fields.chunks_summary[0].substring(0, 100));
    }
  } else {
    console.log("Doc not found");
  }
}

run().catch(console.error);
