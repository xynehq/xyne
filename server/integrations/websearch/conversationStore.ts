/**
 * Conversation Store for Web Search Followup Queries
 *
 * Manages conversation context and previous search results for followup queries
 */

interface ConversationContext {
  conversationId: string
  queries: Array<{
    query: string
    timestamp: Date
    results: string
    urls: string[]
  }>
  createdAt: Date
  lastUpdated: Date
}

class ConversationStore {
  private conversations: Map<string, ConversationContext> = new Map()
  private readonly TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

  /**
   * Store a search query and its results for future followup context
   */
  storeConversation(
    conversationId: string,
    query: string,
    results: string,
    urls: string[],
  ): void {
    const now = new Date()

    if (this.conversations.has(conversationId)) {
      const context = this.conversations.get(conversationId)!
      context.queries.push({
        query,
        timestamp: now,
        results,
        urls,
      })
      context.lastUpdated = now

      // Keep only last 5 queries to prevent memory bloat
      if (context.queries.length > 5) {
        context.queries = context.queries.slice(-5)
      }
    } else {
      this.conversations.set(conversationId, {
        conversationId,
        queries: [
          {
            query,
            timestamp: now,
            results,
            urls,
          },
        ],
        createdAt: now,
        lastUpdated: now,
      })
    }
  }

  /**
   * Get conversation context for a followup query
   */
  getConversationContext(conversationId: string): ConversationContext | null {
    const context = this.conversations.get(conversationId)

    if (!context) {
      return null
    }

    // Check if conversation has expired
    const now = new Date()
    if (now.getTime() - context.lastUpdated.getTime() > this.TTL_MS) {
      this.conversations.delete(conversationId)
      return null
    }

    return context
  }

  /**
   * Build contextual information from previous queries
   */
  buildFollowupContext(conversationId: string): {
    previousQueries: string[]
    previousResults: string
    relatedUrls: string[]
  } {
    const context = this.getConversationContext(conversationId)

    if (!context || context.queries.length === 0) {
      return {
        previousQueries: [],
        previousResults: "",
        relatedUrls: [],
      }
    }

    const previousQueries = context.queries.map((q) => q.query)
    const previousResults = context.queries
      .map((q) => q.results)
      .join("\n\n---\n\n")

    const relatedUrls = context.queries
      .flatMap((q) => q.urls)
      .filter((url, index, arr) => arr.indexOf(url) === index) // Deduplicate

    return {
      previousQueries,
      previousResults,
      relatedUrls,
    }
  }

  /**
   * Calculate how well a new query relates to previous context
   */
  calculateContextRelevance(newQuery: string, conversationId: string): number {
    const context = this.getConversationContext(conversationId)

    if (!context || context.queries.length === 0) {
      return 0
    }

    const previousQueries = context.queries.map((q) => q.query.toLowerCase())
    const previousResults = context.queries.map((q) => q.results.toLowerCase())
    const newQueryLower = newQuery.toLowerCase()

    // Check both previous queries AND previous results for context
    const allPreviousText = [...previousQueries, ...previousResults].join(" ")

    // Simple keyword overlap scoring with more lenient matching
    const newQueryWords = newQueryLower
      .split(/\s+/)
      .filter((word) => word.length > 2)
    const previousWords = allPreviousText
      .split(/\s+/)
      .filter((word) => word.length > 2)

    let totalOverlap = 0

    for (const newWord of newQueryWords) {
      const hasMatch = previousWords.some(
        (prevWord) =>
          prevWord.includes(newWord) ||
          newWord.includes(prevWord) ||
          this.calculateSimilarity(newWord, prevWord) > 0.6 ||
          this.areRelatedWords(newWord, prevWord),
      )

      if (hasMatch) {
        totalOverlap++
      }
    }

    // Also check for semantic relationships - if asking about characters after asking about a story
    const semanticBoost = this.getSemanticBoost(newQueryLower, allPreviousText)

    const baseScore =
      newQueryWords.length > 0 ? totalOverlap / newQueryWords.length : 0
    const finalScore = Math.min(baseScore + semanticBoost, 1.0)

    console.log(
      `Context relevance for "${newQuery}": base=${baseScore.toFixed(2)}, semantic=${semanticBoost.toFixed(2)}, final=${finalScore.toFixed(2)}`,
    )

    return finalScore
  }

  /**
   * Check if two words are semantically related
   */
  private areRelatedWords(word1: string, word2: string): boolean {
    const relationships = {
      characters: ["character", "people", "cast", "person", "individual"],
      main: ["primary", "key", "important", "central", "lead", "major"],
      story: ["plot", "book", "novel", "tale", "narrative", "story"],
      author: ["writer", "creator", "written", "created"],
      who: ["person", "people", "character", "individual"],
      what: ["thing", "concept", "idea", "definition"],
      where: ["location", "place", "site"],
      when: ["time", "date", "period"],
      why: ["reason", "cause", "purpose"],
      how: ["method", "way", "process"],
    }

    for (const [key, related] of Object.entries(relationships)) {
      if (
        (word1.includes(key) && related.some((r) => word2.includes(r))) ||
        (word2.includes(key) && related.some((r) => word1.includes(r)))
      ) {
        return true
      }
    }

    return false
  }

  /**
   * Get semantic boost for related concepts
   */
  private getSemanticBoost(newQuery: string, previousText: string): number {
    let boost = 0

    // Question-based followups about any topic
    if (
      newQuery.includes("characters") &&
      (previousText.includes("story") ||
        previousText.includes("book") ||
        previousText.includes("movie") ||
        previousText.includes("show"))
    ) {
      boost += 0.4
    }

    if (newQuery.includes("who") && previousText.length > 50) {
      boost += 0.3
    }

    if (
      newQuery.includes("main") &&
      (previousText.includes("story") ||
        previousText.includes("book") ||
        previousText.includes("movie") ||
        previousText.includes("show"))
    ) {
      boost += 0.3
    }

    if (
      newQuery.includes("author") &&
      (previousText.includes("book") ||
        previousText.includes("written") ||
        previousText.includes("novel"))
    ) {
      boost += 0.3
    }

    if (
      newQuery.includes("creator") &&
      (previousText.includes("created") ||
        previousText.includes("made") ||
        previousText.includes("developed"))
    ) {
      boost += 0.3
    }

    // General semantic patterns for question words
    if (
      (newQuery.includes("who") ||
        newQuery.includes("what") ||
        newQuery.includes("where") ||
        newQuery.includes("when") ||
        newQuery.includes("why") ||
        newQuery.includes("how")) &&
      previousText.length > 100
    ) {
      boost += 0.2
    }

    return Math.min(boost, 0.6) // Cap the boost
  }

  /**
   * Simple string similarity calculation
   */
  private calculateSimilarity(str1: string, str2: string): number {
    if (str1 === str2) return 1.0
    if (str1.length < 3 || str2.length < 3) return 0

    const longer = str1.length > str2.length ? str1 : str2
    const shorter = str1.length > str2.length ? str2 : str1

    if (longer.includes(shorter)) return 0.8

    // Simple character overlap
    let matches = 0
    for (let i = 0; i < shorter.length; i++) {
      if (longer.includes(shorter[i])) matches++
    }

    return matches / shorter.length
  }

  /**
   * Auto-detect if a query is likely a followup to previous context
   */
  isLikelyFollowup(query: string, conversationId: string): boolean {
    const context = this.getConversationContext(conversationId)
    if (!context || context.queries.length === 0) return false

    const queryLower = query.toLowerCase()

    // Use semantic analysis instead of keyword matching
    const semanticFollowupScore = this.calculateSemanticFollowupProbability(
      query,
      conversationId,
    )

    if (semanticFollowupScore > 0.6) {
      console.log(
        `Detected followup based on semantic analysis: "${query}" (score: ${semanticFollowupScore.toFixed(2)})`,
      )
      return true
    }

    // Calculate contextual relevance
    const relevanceScore = this.calculateContextRelevance(query, conversationId)

    // If the query has significant contextual relevance and previous conversation exists, it's likely a followup
    // Increased threshold from 0.2 to 0.3 to reduce false positives
    if (relevanceScore > 0.3 && context.queries.length > 0) {
      console.log(
        `Detected followup based on context relevance: "${query}" (relevance: ${relevanceScore.toFixed(2)})`,
      )
      return true
    }

    return false
  }

  /**
   * Calculate semantic probability that a query is a followup using advanced analysis
   */
  private calculateSemanticFollowupProbability(
    query: string,
    conversationId: string,
  ): number {
    const context = this.getConversationContext(conversationId)
    if (!context || context.queries.length === 0) return 0

    const queryLower = query.toLowerCase().trim()
    let followupScore = 0

    // 1. Query length analysis - very short queries are often followups
    if (query.split(" ").length <= 3) {
      followupScore += 0.3
    }

    // 2. Pronoun density - high pronoun usage indicates dependency on context
    const pronouns = [
      "it",
      "this",
      "that",
      "they",
      "them",
      "these",
      "those",
      "he",
      "she",
      "his",
      "her",
      "their",
    ]
    const words = queryLower.split(/\s+/)
    const pronounCount = words.filter((word) => pronouns.includes(word)).length
    const pronounDensity = pronounCount / Math.max(words.length, 1)

    if (pronounDensity > 0.2) {
      followupScore += 0.4
    }

    // 3. Incomplete sentence structure detection
    const isIncompleteQuestion =
      /^(what|who|where|when|why|how)(\s+\w{1,4})?(\s*\?)?$/i.test(queryLower)
    const isIncompleteStatement =
      /^(tell|explain|describe|continue|more)(\s+\w{1,4})?$/i.test(queryLower)

    if (isIncompleteQuestion || isIncompleteStatement) {
      followupScore += 0.5
    }

    // 4. Contextual word overlap with previous queries/results
    const previousContext = this.getPreviousContextText(conversationId)
    const contextualOverlap = this.calculateContextualSimilarity(
      queryLower,
      previousContext,
    )

    followupScore += contextualOverlap * 0.3

    // 5. Question word without clear object ("what about?", "how so?", etc.)
    const vagueQuestionPatterns = [
      /^(what|how|why)(\s+(about|so|then|now|exactly))?(\s*\?)?$/i,
      /^(tell me|explain|describe|elaborate)(\s+(more|further|again))?$/i,
      /^(continue|go on|keep going|more details?)$/i,
    ]

    if (vagueQuestionPatterns.some((pattern) => pattern.test(queryLower))) {
      followupScore += 0.6
    }

    // 6. Temporal indicators suggesting continuation
    const continuationWords = [
      "then",
      "next",
      "after",
      "also",
      "and",
      "but",
      "however",
      "moreover",
    ]
    if (continuationWords.some((word) => queryLower.includes(word))) {
      followupScore += 0.2
    }

    // 7. Semantic coherence with previous topic
    const topicCoherence = this.calculateTopicCoherence(query, conversationId)
    followupScore += topicCoherence * 0.4

    return Math.min(followupScore, 1.0)
  }

  /**
   * Get all previous context text (queries + results)
   */
  private getPreviousContextText(conversationId: string): string {
    const context = this.getConversationContext(conversationId)
    if (!context) return ""

    const allText = context.queries
      .map((q) => `${q.query} ${q.results}`)
      .join(" ")
    return allText.toLowerCase()
  }

  /**
   * Calculate contextual similarity using semantic understanding
   */
  private calculateContextualSimilarity(
    query: string,
    previousContext: string,
  ): number {
    if (!previousContext) return 0

    const queryWords = query.split(/\s+/).filter((word) => word.length > 2)
    const contextWords = previousContext
      .split(/\s+/)
      .filter((word) => word.length > 2)

    if (queryWords.length === 0) return 0

    let semanticMatches = 0

    for (const queryWord of queryWords) {
      // Exact matches
      if (contextWords.includes(queryWord)) {
        semanticMatches += 1
        continue
      }

      // Partial matches and semantic relationships
      const hasSemanticMatch = contextWords.some((contextWord) => {
        // Substring matching
        if (
          contextWord.includes(queryWord) ||
          queryWord.includes(contextWord)
        ) {
          return true
        }

        // Root word matching (simple stemming)
        const queryRoot = this.getWordRoot(queryWord)
        const contextRoot = this.getWordRoot(contextWord)
        if (queryRoot === contextRoot && queryRoot.length > 3) {
          return true
        }

        // Semantic relationships
        return this.areRelatedWords(queryWord, contextWord)
      })

      if (hasSemanticMatch) {
        semanticMatches += 0.7
      }
    }

    return semanticMatches / queryWords.length
  }

  /**
   * Calculate topic coherence between current query and previous conversation
   */
  private calculateTopicCoherence(
    query: string,
    conversationId: string,
  ): number {
    const context = this.getConversationContext(conversationId)
    if (!context || context.queries.length === 0) return 0

    // Get the most recent query and result for topic analysis
    const recentQuery = context.queries[context.queries.length - 1]
    const combinedPreviousText =
      `${recentQuery.query} ${recentQuery.results}`.toLowerCase()

    // Extract key entities and topics from both
    const currentEntities = this.extractEntities(query.toLowerCase())
    const previousEntities = this.extractEntities(combinedPreviousText)

    // Calculate entity overlap
    const entityOverlap = this.calculateEntityOverlap(
      currentEntities,
      previousEntities,
    )

    // Check for topical coherence (related concepts)
    const topicalSimilarity = this.calculateTopicalSimilarity(
      query.toLowerCase(),
      combinedPreviousText,
    )

    return Math.max(entityOverlap, topicalSimilarity)
  }

  /**
   * Extract potential entities (proper nouns, important terms)
   */
  private extractEntities(text: string): string[] {
    // Extract capitalized words (proper nouns)
    const properNouns = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || []

    // Extract important domain-specific terms
    const importantTerms =
      text.match(
        /\b(technology|science|business|politics|sports|entertainment|health|education|environment|economy|artificial|intelligence|machine|learning|blockchain|cryptocurrency|climate|renewable|sustainable)\w*\b/gi,
      ) || []

    return [...properNouns, ...importantTerms].map((entity) =>
      entity.toLowerCase(),
    )
  }

  /**
   * Calculate overlap between entity sets
   */
  private calculateEntityOverlap(
    entities1: string[],
    entities2: string[],
  ): number {
    if (entities1.length === 0 || entities2.length === 0) return 0

    const overlap = entities1.filter((entity) =>
      entities2.some((e2) => e2.includes(entity) || entity.includes(e2)),
    ).length

    return overlap / Math.max(entities1.length, entities2.length)
  }

  /**
   * Calculate topical similarity between texts
   */
  private calculateTopicalSimilarity(text1: string, text2: string): number {
    // Define topic clusters
    const topicClusters = {
      technology: [
        "computer",
        "software",
        "digital",
        "internet",
        "cyber",
        "tech",
        "ai",
        "artificial",
        "intelligence",
        "machine",
        "learning",
        "algorithm",
        "data",
        "programming",
        "coding",
      ],
      business: [
        "company",
        "business",
        "market",
        "finance",
        "economy",
        "trade",
        "industry",
        "corporate",
        "enterprise",
        "startup",
        "revenue",
        "profit",
      ],
      science: [
        "research",
        "study",
        "scientific",
        "experiment",
        "theory",
        "discovery",
        "analysis",
        "methodology",
        "hypothesis",
        "evidence",
      ],
      health: [
        "medical",
        "health",
        "disease",
        "treatment",
        "therapy",
        "medicine",
        "clinical",
        "patient",
        "diagnosis",
        "surgery",
      ],
      education: [
        "education",
        "learning",
        "teaching",
        "school",
        "university",
        "student",
        "academic",
        "curriculum",
        "knowledge",
        "training",
      ],
    }

    const getTopicScores = (text: string) => {
      const scores: { [key: string]: number } = {}

      for (const [topic, keywords] of Object.entries(topicClusters)) {
        scores[topic] = keywords.filter((keyword) =>
          text.includes(keyword),
        ).length
      }

      return scores
    }

    const scores1 = getTopicScores(text1)
    const scores2 = getTopicScores(text2)

    // Calculate cosine similarity between topic vectors
    let dotProduct = 0
    let norm1 = 0
    let norm2 = 0

    for (const topic of Object.keys(topicClusters)) {
      dotProduct += scores1[topic] * scores2[topic]
      norm1 += scores1[topic] * scores1[topic]
      norm2 += scores2[topic] * scores2[topic]
    }

    const denominator = Math.sqrt(norm1) * Math.sqrt(norm2)
    return denominator > 0 ? dotProduct / denominator : 0
  }

  /**
   * Simple word root extraction (basic stemming)
   */
  private getWordRoot(word: string): string {
    // Remove common suffixes
    const suffixes = [
      "ing",
      "ed",
      "er",
      "est",
      "ly",
      "tion",
      "sion",
      "ness",
      "ment",
      "able",
      "ible",
    ]

    for (const suffix of suffixes) {
      if (word.endsWith(suffix) && word.length > suffix.length + 2) {
        return word.slice(0, -suffix.length)
      }
    }

    return word
  }

  /**
   * Clean up expired conversations
   */
  cleanup(): void {
    const now = new Date()
    const expiredIds: string[] = []

    for (const [id, context] of this.conversations.entries()) {
      if (now.getTime() - context.lastUpdated.getTime() > this.TTL_MS) {
        expiredIds.push(id)
      }
    }

    expiredIds.forEach((id) => this.conversations.delete(id))
  }
}

// Export singleton instance
export const conversationStore = new ConversationStore()

// Clean up every hour
setInterval(
  () => {
    conversationStore.cleanup()
  },
  60 * 60 * 1000,
)
