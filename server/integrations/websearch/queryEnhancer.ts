/**
 * Query Enhancement Module
 *
 * Handles semantic understanding and enhancement of web search queries,
 * particularly for followup queries and vague references.
 */

import { getLogger } from "../../logger/index.js"
import { Subsystem } from "../../types.js"

const Logger = getLogger(Subsystem.Search)

export interface QueryIntent {
  isQuestion: boolean
  questionType: string | null
  intent: string
  isVagueReference: boolean
  requiresContextSubstitution: boolean
}

export interface SemanticContext {
  summary: string
  entities: string[]
  locations: string[]
  timeReferences: string[]
  keyTopics: string[]
}

/**
 * Enhanced query with previous context for better web search results using semantic understanding
 */
export function enhanceQueryWithContext(
  currentQuery: string,
  previousAnswer: string,
  previousQuery: string,
): string {
  if (!previousAnswer && !previousQuery) return currentQuery

  // First, analyze the current query to understand its intent
  const queryIntent = analyzeQueryIntent(currentQuery, previousQuery)

  // If the query has vague references, resolve them first
  let resolvedQuery = currentQuery
  if (queryIntent.requiresContextSubstitution) {
    resolvedQuery = resolveVagueReferences(
      currentQuery,
      previousQuery,
      previousAnswer,
    )
    Logger.debug(
      `Resolved vague reference: "${currentQuery}" → "${resolvedQuery}"`,
    )
  }

  // Extract semantic context from previous answer
  const semanticContext = extractSemanticContext(previousAnswer, previousQuery)

  // Build contextual query based on semantic understanding
  let contextualQuery = resolvedQuery

  // For question-based followups, create more specific context
  if (queryIntent.isQuestion) {
    const mainSubject = extractMainSubject(previousQuery, previousAnswer)

    if (mainSubject) {
      // Create semantically aware context based on question type
      switch (queryIntent.questionType) {
        case "who":
          contextualQuery = `${resolvedQuery} related to ${mainSubject}. Context: ${semanticContext.entities.join(", ")}. Find comprehensive information with multiple sources.`
          break
        case "what":
          // For "what" questions, especially vague ones, provide rich context
          if (queryIntent.isVagueReference) {
            contextualQuery = `${resolvedQuery} about ${mainSubject}. Building on previous search results: ${semanticContext.summary}. Related entities: ${semanticContext.entities.join(", ")}. Provide detailed explanations with multiple sources and examples.`
          } else {
            contextualQuery = `${resolvedQuery} in relation to ${mainSubject}. Context: ${semanticContext.summary}. Include comprehensive details and multiple perspectives.`
          }
          break
        case "where":
          contextualQuery = `${resolvedQuery} concerning ${mainSubject}. Location context: ${semanticContext.locations.join(", ")}. Provide detailed geographical and contextual information.`
          break
        case "when":
          contextualQuery = `${resolvedQuery} regarding ${mainSubject}. Time context: ${semanticContext.timeReferences.join(", ")}. Include historical timeline and chronological details.`
          break
        case "why":
        case "how":
          contextualQuery = `${resolvedQuery} in relation to ${mainSubject}. Context: ${semanticContext.summary}. Provide comprehensive explanation with causes, mechanisms, and multiple viewpoints.`
          break
        default:
          contextualQuery = `${resolvedQuery} related to ${mainSubject}. Context: ${semanticContext.summary}. Include detailed information from multiple reliable sources.`
      }
    } else {
      contextualQuery = `${resolvedQuery}. Previous discussion: ${semanticContext.summary}. Provide comprehensive information with detailed explanations and multiple sources.`
    }
  } else {
    // For non-question followups, especially vague continuations
    if (queryIntent.isVagueReference) {
      // Provide comprehensive context for vague requests
      const mainSubject = extractMainSubject(previousQuery, previousAnswer)
      contextualQuery = `${resolvedQuery}. Continue providing detailed information about ${mainSubject}. Previous context: ${semanticContext.summary}. Related entities: ${semanticContext.entities.join(", ")}. Find comprehensive coverage with multiple sources and detailed explanations.`
    } else if (semanticContext.entities.length > 0) {
      contextualQuery = `${resolvedQuery} in the context of ${semanticContext.entities.slice(0, 3).join(", ")}. Related info: ${semanticContext.summary}. Provide comprehensive details with multiple sources.`
    } else {
      contextualQuery = `${resolvedQuery}. Building on previous search: ${semanticContext.summary}. Include detailed information with comprehensive coverage.`
    }
  }

  // Only enhance query if it's a followup or has vague references - don't add temporal context automatically
  if (
    queryIntent.isVagueReference &&
    !contextualQuery.includes("comprehensive") &&
    !contextualQuery.includes("detailed")
  ) {
    contextualQuery +=
      " Include comprehensive information with detailed explanations and multiple reliable sources."
  }

  return contextualQuery
}

/**
 * Extract semantic context from previous search results
 */
export function extractSemanticContext(
  text: string,
  query: string,
): SemanticContext {
  if (!text)
    return {
      summary: "",
      entities: [],
      locations: [],
      timeReferences: [],
      keyTopics: [],
    }

  // Extract meaningful sentences (first 3-4 sentences that contain useful info)
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 25)
  const summary = sentences.slice(0, 4).join(". ").substring(0, 300).trim()

  // Enhanced proper noun extraction (potential entities, names, places, organizations)
  const properNounMatches =
    text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) || []

  // Filter out common words that might be capitalized but aren't entities
  const commonNonEntities = [
    "The",
    "This",
    "That",
    "These",
    "Those",
    "When",
    "Where",
    "What",
    "Who",
    "Why",
    "How",
    "And",
    "Or",
    "But",
    "So",
    "If",
    "Then",
    "Now",
    "Here",
    "There",
  ]
  const filteredEntities = properNounMatches.filter(
    (entity) => !commonNonEntities.includes(entity) && entity.length > 2,
  )

  const entities = [...new Set(filteredEntities)].slice(0, 8) // Increased from 5 to 8

  // Enhanced location extraction
  const locationIndicators =
    /(in|at|from|located|based|headquarters|founded in|established in|situated|placed|positioned)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g
  const countryPattern =
    /\b(United States|USA|UK|United Kingdom|Canada|Australia|Germany|France|Japan|China|India|Brazil|Russia|Italy|Spain|Mexico|South Korea|Netherlands|Sweden|Switzerland|Norway|Denmark|Finland|Ireland|Belgium|Austria|Poland|Czech Republic|Hungary|Portugal|Greece|Turkey|Israel|Saudi Arabia|UAE|Egypt|South Africa|Nigeria|Kenya|Argentina|Chile|Colombia|Peru|Venezuela|Thailand|Vietnam|Philippines|Indonesia|Malaysia|Singapore|New Zealand|Pakistan|Bangladesh|Sri Lanka|Nepal|Afghanistan|Iran|Iraq|Jordan|Lebanon|Syria|Qatar|Kuwait|Oman|Bahrain|Morocco|Algeria|Tunisia|Libya|Sudan|Ethiopia|Ghana|Ivory Coast|Cameroon|Uganda|Tanzania|Rwanda|Botswana|Namibia|Zimbabwe|Zambia|Malawi|Madagascar|Mauritius|Seychelles|Maldives|Fiji|Tonga|Samoa|Papua New Guinea|Solomon Islands|Vanuatu|Palau|Micronesia|Marshall Islands|Kiribati|Tuvalu|Nauru)\b/g
  const cityPattern =
    /\b(New York|Los Angeles|Chicago|Houston|Phoenix|Philadelphia|San Antonio|San Diego|Dallas|San Jose|Austin|Jacksonville|Fort Worth|Columbus|Charlotte|San Francisco|Indianapolis|Seattle|Denver|Washington|Boston|El Paso|Nashville|Detroit|Oklahoma City|Portland|Las Vegas|Memphis|Louisville|Baltimore|Milwaukee|Albuquerque|Tucson|Fresno|Sacramento|Mesa|Kansas City|Atlanta|Long Beach|Colorado Springs|Raleigh|Miami|Virginia Beach|Omaha|Oakland|Minneapolis|Tulsa|Arlington|Tampa|New Orleans|Wichita|Cleveland|Bakersfield|Aurora|Anaheim|Honolulu|Santa Ana|Riverside|Corpus Christi|Lexington|Stockton|Henderson|Saint Paul|St. Louis|Cincinnati|Pittsburgh|Greensboro|Lincoln|Plano|Anchorage|Orlando|Irvine|Newark|Toledo|Durham|Chula Vista|Fort Wayne|Jersey City|St. Petersburg|Laredo|Madison|Chandler|Buffalo|Lubbock|Scottsdale|Reno|Glendale|Gilbert|Winston Salem|North Las Vegas|Norfolk|Chesapeake|Garland|Irving|Hialeah|Fremont|Boise|Richmond|Baton Rouge|Spokane|Des Moines|Tacoma|San Bernardino|Modesto|Fontana|Santa Clarita|Birmingham|Oxnard|Fayetteville|Moreno Valley|Akron|Huntington Beach|Little Rock|Augusta|Amarillo|Glendale|Mobile|Grand Rapids|Salt Lake City|Tallahassee|Huntsville|Grand Prairie|Knoxville|Worcester|Newport News|Brownsville|Overland Park|Santa Rosa|Peoria|Oceanside|Tempe|Eugene|Pembroke Pines|Salem|Lancaster|Hayward|Palmdale|Salinas|Springfield|Pasadena|Fort Lauderdale|Alexandria|Lakewood|Kansas City|Hollywood|Torrance|Escondido|Naperville|Dayton|Garden Grove|Rancho Cucamonga|Sterling Heights|Sioux Falls|New Haven|Miami Gardens|Waco|West Valley City|Murfreesboro|McAllen|Columbia|Clarksville|Las Cruces|Clearwater|Miami Beach|Surprise|Thornton|West Jordan|Westminster|Santa Maria|San Mateo|Allentown|Beaumont|Elgin|Odessa|Independence|Concord|San Angelo|Lansing|Ann Arbor|Rochester|Roseville|Cary|Carlsbad|Boulder|Daly City|Temecula|Antioch|High Point|Richardson|Pompano Beach|West Palm Beach|Centennial|Lowell|Billings|Inglewood|Sandy Springs|Manchester|Olathe|Evansville|Coral Springs|Sterling Heights|Columbia|Carrollton|Elizabeth|Midland|Abilene|Pearland|Broken Arrow|College Station|Killeen|McKinney|Cedar Rapids|South Bend|Miami Gardens|Lewisville|Tyler|Davie|Lakeland|Alexandria|Burbank|Round Rock|Richmond|Peoria|Rialto|El Monte|Jurupa Valley|Norwalk|Downey|Inglewood|Costa Mesa|Carlsbad|Fairfield|Ventura|Temecula|Antioch|Richmond|Concord|Simi Valley|Victorville|Santa Clara|Vallejo|Berkeley|El Cajon|Thousand Oaks|San Buenaventura|Sunnyvale|Clovis|Murrieta|Westminster|Orem|Norman|Fargo|Wilmington|Portsmouth|Rochester|Elgin|Mesa|Clearwater|Miami Beach|West Valley City|Provo|Las Cruces|Erie|Springfield|Akron|Shreveport|Sugarland|Mobile|Beaumont|Dayton|Newport News|Brownsville|Fort Lauderdale|Providence|Salt Lake City|Huntsville|Amarillo|Grand Rapids|Tallahassee|Grand Prairie|Overland Park|Knoxville|Worcester|Brownsville|Sioux Falls|Chattanooga|Vancouver|Tacoma|Little Rock|Aurora|Mobile|Jackson|Madison|Montgomery|Des Moines|Yonkers|Spokane|Lubbock|Baton Rouge|Durham|Laredo|North Las Vegas|Henderson|Reno|Scottsdale|Newark|Gilbert|Chandler|Glendale|Hialeah|Garland|Irving|Chesapeake|North Las Vegas|Henderson|Paradise|Enterprise|Spring Valley|Sunrise Manor|Whitney|Summerlin South|Bunkerhill|Paradise|Enterprise|Spring Valley|Winchester|Whitney|Summerlin South|East Las Vegas|Centennial Hills|Lake Las Vegas|The Lakes|Sovana|Mountain Edge|Rhodes Ranch|Southern Highlands|Green Valley|Anthem|Aliante|Eldorado|Inspirada|Silverado Ranch|Mountains Edge|Skye Canyon|Lone Mountain|Tule Springs|Kyle Canyon|Lee Canyon|Red Rock|Blue Diamond|Goodsprings|Jean|Primm|Stateline|Pahrump|Amargosa Valley|Beatty|Goldfield|Tonopah|Austin|Eureka|Ely|Caliente|Alamo|Las Vegas|Henderson|North Las Vegas|Boulder City|Mesquite|West Wendover|Jackpot|Wells|Elko|Carlin|Battle Mountain|Winnemucca|Lovelock|Fallon|Fernley|Sparks|Reno|Carson City|Virginia City|Minden|Gardnerville|Tahoe|Incline Village|Crystal Bay|Glenbrook|Zephyr Cove|Stateline|South Lake Tahoe|Kings Beach|Tahoe City|Truckee|Grass Valley|Nevada City|Auburn|Colfax|Roseville|Rocklin|Lincoln|Loomis|Penryn|Newcastle|Foresthill|Dutch Flat|Gold Run|Emigrant Gap|Soda Springs|Norden|Truckee|Tahoe City|Kings Beach|Carnelian Bay|Tahoe Vista|Crystal Bay|Incline Village|Glenbrook|Zephyr Cove|Stateline|South Lake Tahoe|Meyers|Kyburz|Strawberry|Twin Bridges|Phillips|Echo Lake|Fallen Leaf Lake|Emerald Bay|Vikingsholm|Rubicon Point|DL Bliss|Sugar Pine Point|Homewood|Tahoma|Chambers Landing|McKinney Bay|Obexers|Sunnyside|Tahoe City|Fanny Bridge|Squaw Valley|Alpine Meadows|Northstar|Mt. Rose|Diamond Peak|Heavenly|Kirkwood|Sierra at Tahoe|Boreal|Soda Springs|Sugar Bowl|Donner Ski Ranch|Tahoe Donner|Clair Tappaan|Donner Memorial|Donner Lake|Donner Pass|Donner Summit|Cisco Grove|Yuba Gap|Rainbow|Big Bend|Colfax|Weimar|Applegate|Auburn|Newcastle|Penryn|Loomis|Rocklin|Roseville|Citrus Heights|Antelope|North Highlands|Foothill Farms|Arden|Arcade|Carmichael|Fair Oaks|Orangevale|Folsom|El Dorado Hills|Cameron Park|Shingle Springs|Placerville|Coloma|Lotus|Garden Valley|Kelsey|Greenwood|Georgetown|Cool|Pilot Hill|Newcastle|Loomis|Rocklin|Roseville|Granite Bay|Lincoln|Sheridan|Wheatland|Marysville|Yuba City|Olivehurst|Linda|Plumas Lake|Arboga|Browns Valley|Dobbins|Oregon House|Camptonville|Downieville|Sierra City|Loyalton|Sierraville|Truckee|Tahoe City|Kings Beach|Carnelian Bay|Tahoe Vista|Crystal Bay|Incline Village|Sand Harbor|Glenbrook|Zephyr Cove|Stateline|South Lake Tahoe|Meyers|Camp Richardson|Fallen Leaf Lake|Emerald Bay|Vikingsholm|Rubicon Point|DL Bliss|Sugar Pine Point|Homewood|Tahoma|Chambers Landing|McKinney Bay|Obexers|Sunnyside|Tahoe City|Fanny Bridge|Squaw Valley|Alpine Meadows|Northstar|Mt. Rose|Diamond Peak|Heavenly|Kirkwood|Sierra at Tahoe|Boreal|Soda Springs|Sugar Bowl|Donner Ski Ranch|Tahoe Donner)\b/gi

  const locations: string[] = []
  let locationMatch
  while ((locationMatch = locationIndicators.exec(text)) !== null) {
    locations.push(locationMatch[2])
  }

  // Add country and city matches
  const countryMatches = text.match(countryPattern) || []
  const cityMatches = text.match(cityPattern) || []
  locations.push(...countryMatches, ...cityMatches)

  // Enhanced time reference extraction
  const timePattern =
    /\b(19|20)\d{2}\b|\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b(last|past|recent|current|this|next)\s+(year|month|week|day|decade|century)\b|\b(yesterday|today|tomorrow|recently|currently|formerly|previously|now|then|soon|later|earlier|before|after)\b/gi
  const timeReferences = [...new Set(text.match(timePattern) || [])]

  // Enhanced key topics extraction with better filtering
  const words = text.toLowerCase().split(/\s+/)
  const wordFreq: { [key: string]: number } = {}

  // Common stop words to exclude
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "are",
    "was",
    "were",
    "been",
    "have",
    "has",
    "had",
    "will",
    "would",
    "could",
    "should",
    "that",
    "this",
    "with",
    "from",
    "they",
    "them",
    "their",
    "there",
    "where",
    "when",
    "what",
    "who",
    "how",
    "why",
    "also",
    "can",
    "may",
    "might",
    "must",
    "shall",
    "said",
    "says",
    "such",
    "than",
    "very",
    "more",
    "most",
    "many",
    "much",
    "some",
    "any",
    "all",
    "each",
    "every",
    "other",
    "another",
    "same",
    "different",
    "new",
    "old",
    "first",
    "last",
    "next",
    "good",
    "better",
    "best",
    "well",
    "like",
    "just",
    "only",
    "even",
    "still",
    "way",
    "time",
    "work",
    "life",
    "world",
    "people",
    "things",
    "place",
    "make",
    "take",
    "come",
    "know",
    "see",
    "get",
    "use",
    "find",
    "give",
    "tell",
    "ask",
    "seem",
    "feel",
    "try",
    "leave",
    "call",
  ])

  words.forEach((word) => {
    // Clean the word
    const cleanWord = word.replace(/[^\w]/g, "").toLowerCase()
    if (
      cleanWord.length > 3 &&
      !stopWords.has(cleanWord) &&
      !/^\d+$/.test(cleanWord)
    ) {
      wordFreq[cleanWord] = (wordFreq[cleanWord] || 0) + 1
    }
  })

  const keyTopics = Object.entries(wordFreq)
    .filter(([word, freq]) => freq > 1)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8) // Increased from 5 to 8
    .map(([word]) => word)

  return {
    summary,
    entities: [...new Set(entities)],
    locations: [...new Set(locations.filter((loc) => loc.length > 2))], // Filter out very short matches
    timeReferences,
    keyTopics,
  }
}

/**
 * Resolve vague references and substitute pronouns with actual subjects
 */
export function resolveVagueReferences(
  currentQuery: string,
  previousQuery: string,
  previousAnswer: string,
): string {
  const queryLower = currentQuery.toLowerCase().trim()

  // Extract the main subject/topic from the previous query and answer
  const mainSubject = extractMainSubject(previousQuery, previousAnswer)
  const semanticContext = extractSemanticContext(previousAnswer, previousQuery)

  // Get the most prominent entity from previous context
  const primaryEntity =
    semanticContext.entities.length > 0
      ? semanticContext.entities[0]
      : mainSubject

  // Handle complete vague queries
  if (
    /^(what is it|what's it|what about it|tell me about it|more about it)$/i.test(
      queryLower,
    )
  ) {
    return `what is ${primaryEntity} about`
  }

  if (/^(what is this|what's this|about this)$/i.test(queryLower)) {
    return `what is ${primaryEntity}`
  }

  if (
    /^(continue|continue about|more|elaborate|explain|tell me more|go on)$/i.test(
      queryLower,
    )
  ) {
    return `tell me more about ${primaryEntity}`
  }

  if (
    /^(what is that|what's that|about that|more about that)$/i.test(queryLower)
  ) {
    return `what is ${primaryEntity} about`
  }

  if (/^(it|this|that)(\s+(is|was|about|means?))?$/i.test(queryLower)) {
    return `what is ${primaryEntity}`
  }

  if (
    /^(the same|same thing|continue the same|more about the same)$/i.test(
      queryLower,
    )
  ) {
    return `continue about ${primaryEntity}`
  }

  // Handle partial pronoun substitution
  let resolvedQuery = currentQuery

  // Replace "it" with the primary entity when it appears to be a vague reference
  if (
    /\bit\b/i.test(resolvedQuery) &&
    !/\bit is\b|\bit was\b|\bit will\b|\bit has\b|\bit can\b/i.test(
      resolvedQuery,
    )
  ) {
    resolvedQuery = resolvedQuery.replace(/\bit\b/gi, primaryEntity)
  }

  // Replace "this" when it's vague
  if (
    /\bthis\b/i.test(resolvedQuery) &&
    !/\bthis is\b|\bthis was\b|\bthis will\b/i.test(resolvedQuery)
  ) {
    resolvedQuery = resolvedQuery.replace(/\bthis\b/gi, primaryEntity)
  }

  // Replace "that" when it's vague
  if (
    /\bthat\b/i.test(resolvedQuery) &&
    !/\bthat is\b|\bthat was\b|\bthat will\b/i.test(resolvedQuery)
  ) {
    resolvedQuery = resolvedQuery.replace(/\bthat\b/gi, primaryEntity)
  }

  // Handle "they/them" with multiple entities
  if (
    /\b(they|them)\b/i.test(resolvedQuery) &&
    semanticContext.entities.length > 1
  ) {
    const entitiesPhrase = semanticContext.entities.slice(0, 3).join(", ")
    resolvedQuery = resolvedQuery.replace(/\b(they|them)\b/gi, entitiesPhrase)
  }

  return resolvedQuery
}

/**
 * Analyze query intent and type for better context understanding
 */
export function analyzeQueryIntent(
  query: string,
  previousQuery?: string,
): QueryIntent {
  const queryLower = query.toLowerCase().trim()

  // Check if it's a question
  const questionWords = ["who", "what", "where", "when", "why", "how"]
  const isQuestion =
    questionWords.some((word) => queryLower.startsWith(word)) ||
    queryLower.endsWith("?")

  let questionType: string | null = null
  if (isQuestion) {
    questionType =
      questionWords.find((word) => queryLower.startsWith(word)) || "general"
  }

  // Check for vague references that need context substitution
  const vaguePatterns = [
    /^(what is it|what's it|what about it|tell me about it|more about it|what is this|what's this|about this)$/i,
    /^(continue|continue about|more|elaborate|explain|tell me more|go on)$/i,
    /^(what is that|what's that|about that|more about that)$/i,
    /^(it|this|that)(\s+(is|was|about|means?))?$/i,
    /^(the same|same thing|continue the same|more about the same)$/i,
  ]

  const isVagueReference = vaguePatterns.some((pattern) =>
    pattern.test(queryLower),
  )

  // Check if query requires context substitution (contains pronouns without clear referents)
  const pronouns = ["it", "this", "that", "they", "them", "these", "those"]
  const containsPronouns = pronouns.some(
    (pronoun) =>
      queryLower.includes(pronoun) &&
      !queryLower.includes(`${pronoun} is`) &&
      !queryLower.includes(`${pronoun} was`),
  )

  const requiresContextSubstitution =
    isVagueReference || (containsPronouns && query.split(" ").length < 6) // Short queries with pronouns likely need context

  // Determine intent based on keywords and patterns
  let intent = "general"

  if (isVagueReference && previousQuery) {
    // For vague references, inherit intent from previous query
    const prevIntent = analyzeQueryIntent(previousQuery)
    intent = prevIntent.intent
  } else if (
    queryLower.includes("character") ||
    queryLower.includes("people") ||
    queryLower.includes("person")
  ) {
    intent = "character_info"
  } else if (
    queryLower.includes("company") ||
    queryLower.includes("organization") ||
    queryLower.includes("business")
  ) {
    intent = "company_info"
  } else if (
    queryLower.includes("location") ||
    queryLower.includes("place") ||
    queryLower.includes("where")
  ) {
    intent = "location_info"
  } else if (
    queryLower.includes("time") ||
    queryLower.includes("when") ||
    queryLower.includes("date")
  ) {
    intent = "temporal_info"
  } else if (
    queryLower.includes("how") ||
    queryLower.includes("process") ||
    queryLower.includes("method")
  ) {
    intent = "process_info"
  } else if (
    queryLower.includes("why") ||
    queryLower.includes("reason") ||
    queryLower.includes("because")
  ) {
    intent = "causal_info"
  }

  return {
    isQuestion,
    questionType,
    intent,
    isVagueReference,
    requiresContextSubstitution,
  }
}

/**
 * Extract main subject from a query using semantic understanding
 */
export function extractMainSubject(
  query: string,
  previousContext?: string,
): string {
  const queryLower = query.toLowerCase()
  const words = query.split(/\s+/)

  // Extract potential proper nouns (capitalized words) - these are often key subjects
  const properNouns = words.filter((word) => /^[A-Z]/.test(word))

  if (properNouns.length > 0) {
    return properNouns.join(" ")
  }

  // Use semantic understanding to identify the subject based on query patterns
  if (previousContext) {
    const contextLower = previousContext.toLowerCase()

    // If asking about characters, look for story/book/movie context
    if (queryLower.includes("character") || queryLower.includes("who")) {
      const storyIndicators = [
        "story",
        "book",
        "novel",
        "movie",
        "film",
        "show",
        "series",
      ]
      for (const indicator of storyIndicators) {
        if (contextLower.includes(indicator)) {
          // Extract the story/book/movie name from previous context
          const contextWords = previousContext.split(/\s+/)
          const contextProperNouns = contextWords.filter((word) =>
            /^[A-Z]/.test(word),
          )
          if (contextProperNouns.length > 0) {
            return contextProperNouns.slice(0, 2).join(" ")
          }
        }
      }
    }

    // If asking about company/organization info, look for business context
    if (
      queryLower.includes("company") ||
      queryLower.includes("organization") ||
      queryLower.includes("founded")
    ) {
      const businessIndicators = [
        "company",
        "corporation",
        "business",
        "organization",
        "founded",
        "startup",
      ]
      for (const indicator of businessIndicators) {
        if (contextLower.includes(indicator)) {
          const contextWords = previousContext.split(/\s+/)
          const contextProperNouns = contextWords.filter((word) =>
            /^[A-Z]/.test(word),
          )
          if (contextProperNouns.length > 0) {
            return contextProperNouns.slice(0, 2).join(" ")
          }
        }
      }
    }

    // For location-based queries, look for place names
    if (queryLower.includes("where") || queryLower.includes("location")) {
      const locationWords = previousContext.match(
        /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g,
      )
      if (locationWords && locationWords.length > 0) {
        return locationWords.slice(0, 2).join(" ")
      }
    }
  }

  // Extract meaningful nouns, excluding common question words and articles
  const meaningfulWords = words.filter((word) => {
    const wordLower = word.toLowerCase()
    return (
      word.length > 3 &&
      ![
        "what",
        "who",
        "where",
        "when",
        "why",
        "how",
        "the",
        "and",
        "for",
        "about",
        "tell",
        "more",
        "some",
        "this",
        "that",
        "they",
        "them",
        "their",
      ].includes(wordLower) &&
      !/^(is|are|was|were|been|being|have|has|had|do|does|did|will|would|should|could|can|may|might)$/i.test(
        wordLower,
      )
    )
  })

  // Prioritize nouns that appear to be subjects (not at the start if it's a question word)
  const isQuestion = /^(who|what|where|when|why|how)\b/i.test(query)
  const startIndex = isQuestion ? 1 : 0

  const subjectWords = meaningfulWords.slice(startIndex, startIndex + 3)
  return subjectWords.join(" ") || meaningfulWords.slice(0, 2).join(" ")
}
