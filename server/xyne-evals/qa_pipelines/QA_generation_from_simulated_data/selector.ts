import * as readline from "readline"
import { generator } from "./generator.js"
import { DataStore, GroupMetadata } from "./dataStore.js"

// Hardcoded depth for simulation
const D = 50 //this is each workspace's depth, this value is the max number of datapoints can be collected in a group

// Helper to get random int in [min, max]
function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

// Helper to pick random element
function randChoice<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)]
}

// Traverse references up/down to a certain number of data points using DataStore
function traverseRefs(
  dataStore: DataStore,
  rootId: string,
  maxDataPoints: number,
): Set<string> {
  console.log(
    `🔍 Starting reference traversal from root: ${rootId}, maxDataPoints: ${maxDataPoints}`,
  )

  try {
    const rootDoc = dataStore.getDocument(rootId)
    if (!rootDoc) {
      console.error(`❌ Root ID ${rootId} not found in data store!`)
      return new Set()
    }

    const visited = new Set<string>()
    const queue: [string, number][] = [[rootId, 0]]
    let iterations = 0
    const allDocIds = dataStore.getAllDocIds()

    while (queue.length && visited.size < maxDataPoints) {
      iterations++
      if (iterations > 10000) {
        console.error("❌ Infinite loop detected in traverseRefs, breaking...")
        break
      }

      const [currId, depth] = queue.shift()!
      if (visited.has(currId)) continue

      // Check if adding this node would exceed maxDataPoints
      if (visited.size >= maxDataPoints) {
        break
      }

      visited.add(currId)
      const obj = dataStore.getDocument(currId)
      if (!obj) {
        console.warn(`⚠️  Document not found for ID: ${currId}`)
        continue
      }

      const refs = obj.fields?.refs || []
      const refIds = refs.map((ref: any) => ref.refId).filter(Boolean)
      console.log(
        `🔗 Processing ${currId} at depth ${depth}, found ${refs.length} references, extracted ${refIds.length} refIds (visited: ${visited.size}/${maxDataPoints})`,
      )

      // Add forward references (following refs.refId)
      for (const refId of refIds) {
        if (!visited.has(refId) && dataStore.getDocument(refId)) {
          console.log(`  ➡️  Adding forward reference: ${refId}`)
          queue.push([refId, depth + 1])
        } else if (!dataStore.getDocument(refId)) {
          console.warn(`  ⚠️  Referenced document not found: ${refId}`)
        }
      }

      // Add backward references (find parents that reference currId)
      for (const docId of allDocIds) {
        const doc = dataStore.getDocument(docId)
        if (doc?.fields?.refs) {
          const parentRefIds = doc.fields.refs.map((ref: any) => ref.refId)
          if (parentRefIds.includes(currId) && !visited.has(docId)) {
            console.log(`  ⬅️  Adding backward reference: ${docId} -> ${currId}`)
            queue.push([docId, depth + 1])
          }
        }
      }
    }

    const stopReason =
      visited.size >= maxDataPoints
        ? "maxDataPoints reached"
        : "no more children to explore"
    console.log(
      `✅ Traversal completed after ${iterations} iterations, visited ${visited.size} nodes (${stopReason})`,
    )
    return visited
  } catch (err) {
    console.error("❌ Error in traverseRefs:", err)
    return new Set()
  }
}

// Main selector function
export async function selector(
  data: string,
  k: number,
): Promise<GroupMetadata[]> {
  console.log(
    `🚀 Starting memory-optimized selector with k=${k} groups to generate`,
  )

  try {
    // Initialize and load data into shared store
    const dataStore = DataStore.getInstance()
    dataStore.loadData(data)

    console.log("🔍 Extracting document IDs from store...")
    const allIds = dataStore.getAllDocIds()
    console.log(`📋 Found ${allIds.length} valid document IDs in data store`)

    if (allIds.length === 0) {
      console.error("❌ No valid document IDs found! Cannot proceed.")
      throw new Error("No valid document IDs found in data")
    }

    if (k <= 0) {
      console.error(`❌ Invalid k value: ${k}. Must be positive.`)
      throw new Error(`Invalid k value: ${k}`)
    }

    const groups: GroupMetadata[] = []

    for (let i = 0; i < k; ++i) {
      console.log(`\n📦 Generating group ${i + 1} of ${k}...`)

      // Randomly pick a root
      if (allIds.length === 0) {
        console.error("❌ No IDs available to select from!")
        throw new Error("No IDs available for selection")
      }

      const rootId = randChoice(allIds)
      console.log(`🎯 Selected root ID: ${rootId}`)

      // Randomly assign coverage_preference
      const prefs = ["low", "medium", "high"] as const
      let coverage_preference = randChoice(Array.from(prefs))
      console.log(`🎲 Random coverage preference: ${coverage_preference}`)

      // Decide depth range
      let minDepth = 1,
        maxDepth = D
      if (coverage_preference === "low") {
        minDepth = 1
        maxDepth = Math.floor(D / 3)
      } else if (coverage_preference === "medium") {
        minDepth = Math.floor(D / 4)
        maxDepth = Math.floor((2 * D) / 3)
      } else if (coverage_preference === "high") {
        minDepth = Math.floor((2 * D) / 3)
        maxDepth = D
      }

      const depth = randInt(minDepth, maxDepth)
      console.log(
        `📏 Depth range: ${minDepth}-${maxDepth}, selected depth: ${depth}`,
      )

      // Traverse refs to collect group IDs (memory efficient!)
      const idSet = traverseRefs(dataStore, rootId, depth)

      if (idSet.size === 0) {
        console.error(`❌ No IDs found during traversal for root ${rootId}!`)
        console.log("⚠️  Continuing with empty group...")
      }

      console.log(
        `🗂️  Group ${i + 1} contains ${idSet.size} document IDs (no data copied yet)`,
      )

      // Optionally reassign coverage_preference based on actual size
      const actualSize = idSet.size
      let newPref = coverage_preference
      if (actualSize < D / 3) newPref = "low"
      else if (actualSize < (2 * D) / 3) newPref = "medium"
      else newPref = "high"

      console.log(
        `📊 Coverage adjustment: ${coverage_preference} → ${newPref} (size: ${actualSize})`,
      )

      const group: GroupMetadata = {
        rootId,
        docIds: idSet, // Only storing IDs, not full documents!
        intended_coverage_preference: coverage_preference,
        actual_coverage_preference: newPref,
        depth,
        actualSize,
      }

      groups.push(group)
      console.log(`✅ Group ${i + 1} created successfully (memory efficient)`)
    }

    // For demonstration, just log the groups
    console.log("\n📋 Final group summary:")
    groups.forEach((g, idx) => {
      console.log(
        `Group ${idx + 1}: root=${g.rootId}, intended=${g.intended_coverage_preference}, actual=${g.actual_coverage_preference}, maxDataPoints=${g.depth}, size=${g.actualSize}`,
      )
    })

    // Call generator sequentially for each group
    console.log("\n🔄 Starting generator calls...")
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]
      console.log(`\n🤖 Calling generator for group ${i + 1}...`)

      try {
        await generator(group, 5, i + 1) // Pass group number (i + 1)
        console.log(`✅ Generator completed for group ${i + 1}`)
      } catch (err) {
        console.error(`❌ Generator failed for group ${i + 1}:`, err)
        throw err
      }
    }

    console.log("\n🎉 All groups processed successfully!")
    console.log(
      `💾 Memory usage optimized: only ${groups.length} lightweight metadata objects created`,
    )
    return groups
  } catch (err) {
    console.error("❌ Critical error in selector function:", err)
    throw err
  }
}
