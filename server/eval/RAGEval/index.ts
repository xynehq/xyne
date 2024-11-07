import { faker } from "@faker-js/faker"
import fs from "fs/promises"
import path from "path"
import {
  AnswerCorrectness,
  AnswerRelevancy,
  AnswerSimilarity,
  ContextEntityRecall,
  ContextPrecision,
  ContextRecall,
  ContextRelevancy,
  Faithfulness,
  type Score,
} from "autoevals"
import OpenAI from "openai"

interface VespaUser {
  docId: string
  name: string
  email: string
  app: string
  entity: string
  gender?: string
  photoLink?: string
  aliases?: string[]
  language?: string // Changed from language to language to match Vespa schema
  includeInGlobalAddressList: boolean
  urls?: string[]
  // Organization fields
  orgName?: string
  orgJobTitle?: string
  orgDepartment?: string
  orgLocation?: string
  orgDescription?: string
  // Admin fields
  isAdmin: boolean
  isDelegatedAdmin: boolean
  suspended: boolean
  archived: boolean
  // Timestamps
  creationTime: number
  lastLoggedIn: number
  birthday?: number
  occupations?: string[]
  userDefined?: string[]
  customerId?: string
  clientData?: string[]
  owner?: string
}

const userSchema = "user"

type UserType = "employee" | "internal-contact" | "external-contact"

const generateUser = (
  type: UserType = faker.helpers.arrayElement([
    "employee",
    "internal-contact",
    "external-contact",
  ] as UserType[]),
  ownerEmail?: string, // Add owner parameter
): VespaUser => {
  const companyDomain = "xynehq.com"
  const companyName = "Xyne"

  // Base configuration based on user type
  const config = {
    employee: {
      getDomain: () => companyDomain,
      getEntity: () => "user" as const,
      getOrgFields: () => ({
        orgName: companyName,
        orgJobTitle: faker.person.jobTitle(),
        orgDepartment: faker.commerce.department(),
        orgLocation: faker.location.city(),
        orgDescription: faker.company.catchPhrase(),
      }),
    },
    "internal-contact": {
      getDomain: () => companyDomain,
      getEntity: () => "contact" as const,
      getOrgFields: () => ({
        orgName: "",
        orgJobTitle: "",
        orgDepartment: "",
        orgLocation: "",
        orgDescription: "",
      }),
    },
    "external-contact": {
      getDomain: () => faker.internet.domainName(),
      getEntity: () => "contact" as const,
      getOrgFields: () => ({
        orgName: faker.company.name(),
        orgJobTitle: faker.person.jobTitle(),
        orgDepartment: "",
        orgLocation: faker.location.city(),
        orgDescription: "",
      }),
    },
  }

  const firstName = faker.person.firstName()
  const lastName = faker.person.lastName()
  const domain = config[type].getDomain()
  const email =
    type === "external-contact"
      ? faker.internet.email({ firstName, lastName })
      : `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${domain}`

  const baseUser = {
    docId: faker.string.uuid(),
    name: `${firstName} ${lastName}`,
    email,
    app:
      type === "external-contact"
        ? "gmail"
        : faker.helpers.arrayElement(["drive", "calendar", "contacts"]),
    entity: config[type].getEntity(),
    gender: faker.person.gender(),
    photoLink: faker.image.avatar(),
    aliases:
      type === "employee"
        ? [`${firstName}@${domain}`, `${firstName}.${lastName[0]}@${domain}`]
        : [],
    language: faker.helpers.arrayElement(["en", "es", "fr"]), // Changed from language to language
    includeInGlobalAddressList: type !== "external-contact",
    urls:
      type === "employee" ? [faker.internet.url(), faker.internet.url()] : [],
    isAdmin: type === "employee" ? faker.datatype.boolean() : false,
    isDelegatedAdmin: type === "employee" ? faker.datatype.boolean() : false,
    suspended: false,
    archived: false,
    creationTime: faker.date.past().getTime(),
    lastLoggedIn: type === "employee" ? faker.date.recent().getTime() : 0,
    birthday: type === "employee" ? faker.date.birthdate().getTime() : 0,
    occupations:
      type === "employee"
        ? [faker.person.jobType(), faker.person.jobType()]
        : [],
    userDefined:
      type === "employee"
        ? [`custom1:${faker.string.uuid()}`, `custom2:${faker.string.uuid()}`]
        : [],
    customerId: type === "employee" ? faker.string.uuid() : "",
    clientData:
      type === "employee"
        ? [`app1:${faker.string.uuid()}`, `app2:${faker.string.uuid()}`]
        : [],
    owner: ownerEmail || undefined, // Add owner field
    ...config[type].getOrgFields(),
  }

  return baseUser
}

let vespaBaseHost = "0.0.0.0"
const vespaEndpoint = `http://${vespaBaseHost}:8080`
const NAMESPACE = "test" // Replace with your actual namespace
const CLUSTER = "my_content"

const Logger = console

export const insert = async (document: VespaUser, schema: string) => {
  try {
    const response = await fetch(
      `${vespaEndpoint}/document/v1/${NAMESPACE}/${schema}/docid/${document.docId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fields: document }),
      },
    )

    const data = await response.json()

    if (response.ok) {
      // Logger.info(`Document ${document.docId} inserted successfully`)
    } else {
      // Using status text since response.text() return Body Already used Error
      const errorText = response.statusText
      Logger.error(
        `Error inserting document ${document.docId} for ${schema} ${data.message}`,
      )
      throw new Error(
        `Failed to fetch documents: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(
      `Error inserting document ${document.docId}: ${errMessage} ${(error as Error).stack}`,
    )
    throw new Error(
      JSON.stringify({
        docId: document.docId,
        cause: error as Error,
        sources: schema,
      }),
    )
  }
}
export const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message
  return String(error)
}

export const GetDocument = async (
  schema: string,
  docId: string,
): Promise<any> => {
  const url = `${vespaEndpoint}/document/v1/${NAMESPACE}/${schema}/docid/${docId}`
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    })

    if (!response.ok) {
      const errorText = response.statusText
      throw new Error(
        `Failed to fetch document: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }

    const document = await response.json()
    return document
  } catch (error) {
    const errMessage = getErrorMessage(error)
    Logger.error(`Error fetching document ${docId}:  ${errMessage}`)
    throw new Error(
      JSON.stringify({
        docId,
        cause: error as Error,
        sources: schema,
      }),
    )
  }
}

async function deleteAllDocuments(schema: string) {
  // Construct the DELETE URL
  const url = `${vespaEndpoint}/document/v1/${NAMESPACE}/${schema}/docid?selection=true&cluster=${CLUSTER}`

  try {
    const response: Response = await fetch(url, {
      method: "DELETE",
    })

    if (response.ok) {
      Logger.info("All documents deleted successfully.")
    } else {
      const errorText = response.statusText
      throw new Error(
        `Failed to delete documents: ${response.status} ${response.statusText} - ${errorText}`,
      )
    }
  } catch (error) {
    Logger.error(
      `Error deleting documents:, ${error} ${(error as Error).stack}`,
    )
    throw new Error(
      JSON.stringify({
        cause: error as Error,
        sources: "user",
      }),
    )
  }
}

interface EmployeeNetwork {
  employee: VespaUser
  contacts: VespaUser[]
}

const DATASET_PATH = path.resolve(__dirname, "dataset.json")

// Step 1: Add functions to load and save the dataset

const saveDataset = async (networks: EmployeeNetwork[]): Promise<void> => {
  try {
    await fs.writeFile(DATASET_PATH, JSON.stringify(networks, null, 2), "utf-8")
    Logger.info(`Dataset saved to ${DATASET_PATH}`)
  } catch (error) {
    Logger.error(`Error saving dataset:`, error)
    throw error
  }
}

const loadDataset = async (): Promise<EmployeeNetwork[] | null> => {
  try {
    const data = await fs.readFile(DATASET_PATH, "utf-8")
    const networks: EmployeeNetwork[] = JSON.parse(data)
    Logger.info(`Dataset loaded from ${DATASET_PATH}`)
    return networks
  } catch (error) {
    Logger.warn(`Dataset not found. A new dataset will be generated.`)
    return null
  }
}

// Step 2: Modify generateEmployeeNetworks to load from dataset if available

const generateEmployeeNetworks = async (
  numEmployees: number,
  sharedContactsPool: number,
  uniqueContactsPerEmployee: number,
): Promise<EmployeeNetwork[]> => {
  const existingNetworks = await loadDataset()
  if (existingNetworks) {
    return existingNetworks
  }

  const employees = Array.from({ length: numEmployees }, () =>
    generateUser("employee"),
  )
  const sharedContacts = Array.from({ length: sharedContactsPool }, () =>
    generateUser("external-contact"),
  )

  const networks = employees.map((employee) => {
    // Randomly decide the number of shared contacts, allowing zero
    const numSharedContacts = faker.number.int({
      min: 0,
      max: sharedContactsPool,
    })
    const selectedSharedContacts = faker.helpers.arrayElements(
      sharedContacts,
      numSharedContacts,
    )

    // Generate unique contacts with employee as owner
    const uniqueContacts = Array.from(
      { length: uniqueContactsPerEmployee },
      () => generateUser("external-contact", employee.email),
    )

    // Set employee as owner for selected shared contacts
    const contactsWithOwner = selectedSharedContacts.map((contact) => ({
      ...contact,
      owner: employee.email,
    }))

    return {
      employee,
      contacts: [...contactsWithOwner, ...uniqueContacts],
    }
  })

  await saveDataset(networks) // Save the generated dataset

  return networks
}

async function insertAndFetchUsers(): Promise<Map<string, EvaluationMetrics>> {
  const networks = await generateEmployeeNetworks(50, 30, 10)
  const results = new Map<string, EvaluationMetrics>()

  // Insert all users
  for (const network of networks) {
    await insert(network.employee, userSchema)
    for (const contact of network.contacts) {
      await insert(contact, userSchema)
    }
  }

  for (const network of networks) {
    const metrics = await evaluateSearch(networks, network.employee)
    results.set(network.employee.email, metrics)
  }

  return results
}

interface SearchResult {
  id: string // docId
  relevance: number
}

interface EvaluationMetrics {
  precision: number
  recall: number
  ndcg: number
}

interface AggregatedMetrics extends EvaluationMetrics {
  numRuns: number
}

const calculateNDCG = (
  relevanceScores: number[],
  idealScores: number[],
): number => {
  if (relevanceScores.length === 0 || idealScores.length === 0) {
    return 0
  }

  const dcg = relevanceScores.reduce(
    (sum, rel, i) => sum + rel / Math.log2(i + 2),
    0,
  )

  const idcg = idealScores
    .sort((a, b) => b - a)
    .reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0)

  return idcg === 0 ? 0 : dcg / idcg
}

const calculateMetrics = (
  results: SearchResult[],
  groundTruth: Set<string>,
  k: number = 10,
): EvaluationMetrics => {
  const topK = results.slice(0, k)

  const relevantRetrieved = topK.filter((r) => groundTruth.has(r.id)).length
  const expectedRelevant = groundTruth.size // Use the actual number of relevant items

  const precision = relevantRetrieved / topK.length
  const recall = expectedRelevant > 0 ? relevantRetrieved / expectedRelevant : 0

  // NDCG calculation remains same as it already handles graded relevance
  const relevanceScores = topK.map((r) => r.relevance)
  const idealScores = Array.from(groundTruth)
    .slice(0, k)
    .map(() => 1)

  return {
    precision,
    recall,
    ndcg: calculateNDCG(relevanceScores, idealScores),
  }
}

const calculateAverageMetrics = (
  allMetrics: EvaluationMetrics[],
): AggregatedMetrics => {
  const sum = allMetrics.reduce(
    (acc, metrics) => ({
      precision: acc.precision + metrics.precision,
      recall: acc.recall + metrics.recall,
      ndcg: acc.ndcg + metrics.ndcg,
    }),
    { precision: 0, recall: 0, ndcg: 0 },
  )

  const numRuns = allMetrics.length
  return {
    precision: sum.precision / numRuns,
    recall: sum.recall / numRuns,
    ndcg: sum.ndcg / numRuns,
    numRuns,
  }
}

async function evaluateSearch(
  networks: EmployeeNetwork[],
  queryEmployee: VespaUser,
  k: number = 10,
): Promise<EvaluationMetrics> {
  const network = networks.find((n) => n.employee.docId === queryEmployee.docId)
  if (!network) {
    Logger.error(`Network not found for employee ${queryEmployee.docId}`)
    return { precision: 0, recall: 0, ndcg: 0 }
  }

  const groundTruthIds = new Set(network.contacts.map((c) => c.docId))
  if (groundTruthIds.size === 0) {
    Logger.warn(`No contacts found for employee ${queryEmployee.email}`)
    return { precision: 0, recall: 0, ndcg: 0 }
  }

  // Generate natural language query using contact's first name
  const searchQuery = getSearchQuery(network.contacts)

  try {
    // Perform search using Vespa
    const searchResultsData = await searchVespa(
      searchQuery,
      queryEmployee.email,
      null,
      k,
    )

    // Extract search results with Vespa's relevance scores
    const searchResults = searchResultsData.root?.children || []

    if (!Array.isArray(searchResults) || searchResults.length === 0) {
      Logger.error("No search results returned from Vespa")
      return { precision: 0, recall: 0, ndcg: 0 }
    }

    const transformedResults: SearchResult[] = searchResults
      .map((hit: any) => ({
        id: hit.fields?.docId || "",
        relevance: hit.relevance || 0,
      }))
      .filter((result) => result.id)

    // Validate the results using Vespa's relevance scores
    return calculateMetrics(transformedResults, groundTruthIds, k)
  } catch (error) {
    Logger.error(`Search evaluation failed:`, error)
    return { precision: 0, recall: 0, ndcg: 0 }
  }
}

const getSearchQuery = (contacts: VespaUser[]): string => {
  // Use the first two contacts for consistent queries
  const [person1, person2] = contacts.slice(0, 2)

  if (person1 && person2) {
    return `What are the emails of ${person1.name} and ${person2.name}`
  } else if (person1) {
    return `What is the email of ${person1.name}`
  } else {
    return "No contacts available"
  }
}

const calculateOverallMetrics = (
  results: Map<string, EvaluationMetrics>,
): EvaluationMetrics => {
  const metrics = Array.from(results.values())
  return {
    precision:
      metrics.reduce((sum, m) => sum + m.precision, 0) / metrics.length,
    recall: metrics.reduce((sum, m) => sum + m.recall, 0) / metrics.length,
    ndcg: metrics.reduce((sum, m) => sum + m.ndcg, 0) / metrics.length,
  }
}

const runSingleExperiment = async (): Promise<EvaluationMetrics> => {
  await deleteAllDocuments(userSchema)
  const runResults = await insertAndFetchUsers()
  return calculateOverallMetrics(runResults)
}

type YqlProfile = {
  profile: string
  yql: string
}

const HybridDefaultProfile = (
  hits: number,
  app: App | null,
  profile: string = "default",
): YqlProfile => {
  const appFilter = app ? `and app = "${app}"` : ""

  return {
    profile,
    yql: `
      select * from sources ${userSchema}
      where 
      ({targetHits: ${hits * 2}} userInput(@query) ${appFilter})
      or
      ({targetHits: ${hits}} userInput(@query) and owner contains @email)
    `,
  }
}

type App = "User"
export const searchVespa = async (
  query: string,
  email: string,
  app: App | null,
  limit = 8,
  offset?: number,
  fieldset: string = "default",
  rankingProfile: string = "default", // New parameter for ranking profile
): Promise<any> => {
  const url = `${vespaEndpoint}/search/`

  const { yql, profile } = HybridDefaultProfile(limit, app, rankingProfile)

  const searchPayload = {
    yql,
    query,
    email,
    "input.query(e)": "embed(@query)",
    "ranking.profile": profile,
    hits: limit,
    fieldset: fieldset, // Added fieldset parameter
    ...(offset ? { offset } : {}),
  }

  try {
    // Logger.info('Search payload:', JSON.stringify(searchPayload, null, 2))

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(searchPayload),
    })

    if (!response.ok) {
      const errorText = await response.text()
      Logger.error(`Search failed with response: ${errorText}`)
      throw new Error(
        `Search failed: ${response.status} ${response.statusText}`,
      )
    }

    const data = await response.json()
    return data
  } catch (error) {
    Logger.error(`Error performing search:`, error)
    throw error
  }
}

// Function to generate prompts for the LLM based on search results
const generateLLMPrompt = (query: string, context: string): string => {
  return `Answer the following question based on the context provided.\n\nContext:\n${context}\n\nQuestion:\n${query}`
}

// Function to get expected output for a given query
const getExpectedOutput = (query: string): string => {
  // Define expected outputs for evaluation
  // This can be customized based on the query
  return "Expected answer to the query."
}

// Function to evaluate LLM responses using multiple 'autoevals' evaluators
const evaluateLLMResponse = async (
  response: string,
  expected: string,
  input: string,
  context: string[], // Changed from string to string[]
): Promise<Score[]> => {
  const data = { output: response, expected, input, context } // Ensure context is an array

  // Use multiple evaluators
  const scores = await Promise.all([
    AnswerCorrectness(data),
    AnswerRelevancy(data),
    AnswerSimilarity(data),
    ContextEntityRecall(data),
    ContextRelevancy(data),
    ContextRecall(data),
    ContextPrecision(data),
    Faithfulness(data),
  ])

  return scores
}

let OpenAIKey = process.env["OPENAI_API_KEY"]!
const openAIClient = new OpenAI({
  apiKey: OpenAIKey, // This is the default and can be omitted
})

export const calculateCost = (
  { inputTokens, outputTokens }: { inputTokens: number; outputTokens: number },
  cost: Cost,
): number => {
  const inputCost = (inputTokens / 1000) * cost.pricePerThousandInputTokens
  const outputCost = (outputTokens / 1000) * cost.pricePerThousandOutputTokens
  return inputCost + outputCost
}

type Cost = {
  pricePerThousandInputTokens: number
  pricePerThousandOutputTokens: number
}

// 4o-mini
const gptCost = {
  onDemand: {
    pricePerThousandInputTokens: 0.00015,
    pricePerThousandOutputTokens: 0.0006,
  },
  batch: {
    pricePerThousandInputTokens: 0.000075,
    pricePerThousandOutputTokens: 0.0003,
  },
}

// Modify the main execution flow to calculate and log cost
;(async () => {
  try {
    const runMetrics = await runSingleExperiment()
    console.log(`Precision: ${runMetrics.precision.toFixed(3)}`)
    console.log(`Recall: ${runMetrics.recall.toFixed(3)}`)
    console.log(`NDCG: ${runMetrics.ndcg.toFixed(3)}`)

    // After retrieval evaluation, proceed to LLM response evaluation
    const networks = await generateEmployeeNetworks(10, 10, 3)
    for (const network of networks) {
      const employee = network.employee
      const contacts = network.contacts
      const query = getSearchQuery(contacts)
      const contextDocs = contacts.map((contact) => JSON.stringify(contact)) // Ensure it's an array
      const prompt = generateLLMPrompt(query, contextDocs.join("\n")) // Keep prompt as string if needed
      const expectedOutput = getExpectedOutput(query)

      // Call the LLM with the prompt using OpenAI client
      const response = await openAIClient.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
      })

      // Collect the response text
      const responseText = response.choices[0].message?.content || ""

      // Evaluate the LLM response
      const llmMetrics = await evaluateLLMResponse(
        responseText.trim(),
        expectedOutput,
        prompt,
        contextDocs,
      ) // Pass context as array

      // Calculate cost
      const inputTokens = prompt.split(" ").length // Example token count
      const outputTokens = responseText.trim().split(" ").length // Example token count
      const cost = calculateCost(
        { inputTokens, outputTokens },
        gptCost.onDemand,
      )

      // Log the cost
      console.log(`LLM Response Cost: $${cost.toFixed(4)}`)

      // Output the LLM evaluation metrics
      llmMetrics.forEach((metric) => {
        console.log(`Metric: ${metric.name}`)
        console.log(`Score: ${metric.score!.toFixed(3)}`)
        if (metric.metadata) {
          // console.log('Metadata:', JSON.stringify(metric.metadata, null, 2));
        }
        console.log("---------------------------")
      })
    }
  } catch (error) {
    console.error("Experiment failed:", error)
  }
})()
