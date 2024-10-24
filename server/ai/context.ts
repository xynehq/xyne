// aim is to build context based on the internal types
// translate the company to the AI
import {
  fileSchema,
  mailSchema,
  userSchema,
  VespaSearchResultsSchema,
  type VespaFileSearch,
  type VespaMailSearch,
  type VespaSearchResponse,
  type VespaUser,
} from "@/search/types"
import type { z } from "zod"

// Utility to capitalize the first letter of a string
const capitalize = (str: string) => str.charAt(0).toUpperCase() + str.slice(1)

// Function for handling file context
const constructFileContext = (fields: VespaFileSearch): string => {
  return `
App: ${fields.app}
Entity: ${fields.entity}
Title: ${fields.title ? `Title: ${fields.title}` : ""}
${fields.owner ? `Owner: ${fields.owner}` : ""}
${fields.ownerEmail ? `Owner Email: ${fields.ownerEmail}` : ""}
${fields.mimeType ? `Mime Type: ${fields.mimeType}` : ""}
${fields.permissions ? `Permissions: ${fields.permissions.join(", ")}` : ""}
${fields.chunks_summary ? `Content: ${fields.chunks_summary.join("\n")}` : ""}}`
}

// TODO: tell if workspace that this is an employee
const constructUserContext = (fields: VespaUser): string => {
  return `
App: ${fields.app}
Entity: ${fields.entity}
${fields.name ? `Name: ${fields.name}` : ""}
${fields.email ? `Email: ${fields.email}` : ""}
${fields.gender ? `Gender: ${fields.gender}` : ""}
${fields.orgJobTitle ? `Job Title: ${fields.orgJobTitle}` : ""}
${fields.orgDepartment ? `Department: ${fields.orgDepartment}` : ""}
${fields.orgLocation ? `Location: ${fields.orgLocation}` : ""}
`
}

const constructMailContext = (fields: VespaMailSearch): string => {
  return `
App: ${fields.app}
Entity: ${fields.entity}
${fields.subject ? `Subject: ${fields.subject}` : ""}
${fields.from ? `From: ${fields.from}` : ""}
${fields.to ? `To: ${fields.to.join(", ")}` : ""}
${fields.cc ? `Cc: ${fields.cc.join(", ")}` : ""}
${fields.bcc ? `Bcc: ${fields.bcc.join(", ")}` : ""}
${fields.chunks_summary ? `Content: ${fields.chunks_summary.join("\n")}` : ""}}`
}

type AiContext = string
export const answerContextMap = (
  searchResult: z.infer<typeof VespaSearchResultsSchema>,
): AiContext => {
  if (searchResult.fields.sddocname === fileSchema) {
    return constructFileContext(searchResult.fields)
  } else if (searchResult.fields.sddocname === userSchema) {
    return constructUserContext(searchResult.fields)
  } else if (searchResult.fields.sddocname === mailSchema) {
    return constructMailContext(searchResult.fields)
  } else {
    throw new Error("Invalid search result type")
  }
}
