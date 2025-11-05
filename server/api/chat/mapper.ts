import type { MinimalAgentFragment } from "./types"
import type {
  GetPullRequestReviewsPayload,
  GetPullRequestReviewsPayloadItem,
  GetIssuePayload,
  SearchRepositoriesPayload,
  SearchRepositoriesPayloadItemsItem,
  GetPullRequestPayload,
  GetCommitPayload,
  GetMePayload,
  GetPullRequestStatusPayload,
  SearchIssuesPayload,
  SearchIssuesPayloadItemsItem,
  GetPullRequestFilesPayload,
  GetPullRequestFilesPayloadItem,
  ListTagsPayload,
  ListTagsPayloadItem,
  ListBranchesPayload,
  ListBranchesPayloadItem,
  GetIssueCommentsPayload,
  GetIssueCommentsPayloadItem,
  SearchUsersPayload,
  SearchCodePayload,
  SearchCodePayloadItemsItem,
  GetFileContentsPayload,
  GetFileContentsPayloadItem,
} from "@/api/chat/mcp-github-types"
import { getRelativeTime } from "@/utils"
import { flattenObject } from "@/api/chat/utils"
import { getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import { SystemEntity, XyneTools } from "@/shared/types"
import {
  Apps,
  MailEntity,
  MailAttachmentEntity,
  DriveEntity,
  CalendarEntity,
  GooglePeopleEntity,
  GoogleApps,
} from "@xyne/vespa-ts/types"
import type {
  ConversationalParams,
  MetadataRetrievalParams,
  SearchParams,
  SlackRelatedMessagesParams,
  SlackThreadsParams,
  SlackUserProfileParams,
} from "@/api/chat/types"
import config from "@/config"
import { A } from "ollama/dist/shared/ollama.6319775f.mjs"

const getLoggerForMapper = (emailSub: string) =>
  getLoggerWithChild(Subsystem.Chat, { email: emailSub })
const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

export const mapGithubToolResponse = (
  toolName: string,
  parsedJson: any,
  baseFragmentId: string,
  emailSub: string, // For logger context
): { formattedContent: string; newFragments: MinimalAgentFragment[] } => {
  let formattedContent = "Tool returned no parsable content."
  const newFragments: MinimalAgentFragment[] = []
  const Logger = getLoggerForMapper(emailSub)

  switch (toolName) {
    case "get_issue": {
      const issueData = parsedJson as GetIssuePayload
      formattedContent = `Issue: ${issueData.title}\nStatus: ${issueData.state}\nAuthor: ${issueData.user?.login}\nCreated: ${getRelativeTime(new Date(issueData.created_at).getTime())}\n\n${issueData.body?.substring(0, 500) || "No body content."}...`
      newFragments.push({
        id: `${baseFragmentId}-${issueData.id}`,
        content: formattedContent,
        source: {
          app: Apps.Github,
          docId: String(issueData.id),
          title: issueData.title || `Issue #${issueData.number}`,
          entity: SystemEntity.SystemInfo,
          url: issueData.html_url,
        },
        confidence: 1.0,
      })
      break
    }
    case "search_repositories": {
      const searchData = parsedJson as SearchRepositoriesPayload
      if (searchData.items && searchData.items.length > 0) {
        searchData.items.forEach((item: SearchRepositoriesPayloadItemsItem) => {
          let repoContent = `Repository: ${item.full_name}\nDescription: ${item.description || "No description."}\nStars: ${item.stargazers_count}\nLanguage: ${item.language || "N/A"}`
          newFragments.push({
            id: `${baseFragmentId}-item-${item.id}`,
            content: repoContent,
            source: {
              app: Apps.Github,
              docId: String(item.id),
              title: item.full_name,
              entity: SystemEntity.SystemInfo,
              url: item.html_url,
            },
            confidence: 0.9,
          })
        })
        formattedContent = `Found ${searchData.total_count} repositories. Displaying top ${searchData.items.length}.`
      } else {
        formattedContent = "No repositories found matching your query."
      }
      break
    }
    case "get_pull_request": {
      const prData = parsedJson as GetPullRequestPayload
      formattedContent = `Pull Request: ${prData.title}\nStatus: ${prData.state}\nAuthor: ${prData.user?.login}\nCreated: ${getRelativeTime(new Date(prData.created_at).getTime())}\n\n${prData.body?.substring(0, 500) || "No body content."}...`
      newFragments.push({
        id: `${baseFragmentId}-${prData.id}`,
        content: formattedContent,
        source: {
          app: Apps.Github,
          docId: String(prData.id),
          title: prData.title || `PR #${prData.number}`,
          entity: SystemEntity.SystemInfo,
          url: prData.html_url,
        },
        confidence: 1.0,
      })
      break
    }
    case "get_commit": {
      const commitData = parsedJson as GetCommitPayload
      const commitAuthorDate = commitData.commit.author?.date
      const displayDate = commitAuthorDate
        ? getRelativeTime(new Date(commitAuthorDate).getTime())
        : "N/A"
      formattedContent = `Commit: ${commitData.commit.message.split("\n")[0]}\nSHA: ${commitData.sha}\nAuthor: ${commitData.commit.author?.name} (${commitData.commit.author?.email})\nDate: ${displayDate}\n\n${commitData.commit.message.substring(0, 500)}...`
      newFragments.push({
        id: `${baseFragmentId}-${commitData.sha}`,
        content: formattedContent,
        source: {
          app: Apps.Github,
          docId: commitData.sha,
          title:
            commitData.commit.message.split("\n")[0] ||
            `Commit ${commitData.sha}`,
          entity: SystemEntity.SystemInfo,
          url: commitData.html_url,
        },
        confidence: 1.0,
      })
      break
    }
    case "get_me": {
      const meData = parsedJson as GetMePayload
      formattedContent = `User: ${meData.login}\nName: ${meData.name || "N/A"}\nBio: ${meData.bio || "N/A"}\nPublic Repos: ${meData.public_repos}`
      newFragments.push({
        id: `${baseFragmentId}-${meData.id}`,
        content: formattedContent,
        source: {
          app: Apps.Github,
          docId: String(meData.id),
          title: meData.login,
          entity: SystemEntity.SystemInfo,
          url: meData.html_url,
        },
        confidence: 1.0,
      })
      break
    }
    case "get_pull_request_status": {
      const statusData = parsedJson as GetPullRequestStatusPayload
      formattedContent = `PR Status: ${statusData.state}\nSHA: ${statusData.sha}\nTotal Checks: ${statusData.total_count}`
      newFragments.push({
        id: "",
        content: formattedContent,
        source: {
          app: Apps.Github,
          docId: statusData.sha,
          title: `PR Status for SHA ${statusData.sha.substring(0, 7)}`,
          entity: SystemEntity.SystemInfo,
          url: "",
        },
        confidence: 1.0,
      })
      break
    }
    case "search_issues": {
      const searchData = parsedJson as SearchIssuesPayload
      if (searchData.items && searchData.items.length > 0) {
        searchData.items.forEach((item: SearchIssuesPayloadItemsItem) => {
          let issueContent = `Issue: ${item.title}\nNumber: #${item.number}\nState: ${item.state}\nAuthor: ${item.user?.login}\n\n${item.body?.substring(0, 200) || "No body content."}...`
          newFragments.push({
            id: `${baseFragmentId}-issue-${item.id}`,
            content: issueContent,
            source: {
              app: Apps.Github,
              docId: String(item.id),
              title: item.title || `Issue #${item.number}`,
              entity: SystemEntity.SystemInfo,
              url: item.html_url,
            },
            confidence: 0.9,
          })
        })
        formattedContent = `Found ${searchData.total_count} issues. Displaying top ${searchData.items.length}.`
      } else {
        formattedContent = "No issues found matching your query."
      }
      break
    }
    case "get_pull_request_files": {
      const filesData = parsedJson as GetPullRequestFilesPayload
      if (Array.isArray(filesData) && filesData.length > 0) {
        filesData.forEach((file: GetPullRequestFilesPayloadItem) => {
          let fileContent = `File: ${file.filename}\nStatus: ${file.status}\nChanges: +${file.additions} -${file.deletions}`
          newFragments.push({
            id: `${baseFragmentId}-file-${file.sha}`,
            content: fileContent,
            source: {
              app: Apps.Github,
              docId: file.sha,
              title: file.filename,
              entity: SystemEntity.SystemInfo,
              url: file.blob_url,
            },
            confidence: 1.0,
          })
        })
        formattedContent = `Found ${filesData.length} files in PR. Displaying up to ${filesData.length}.`
      } else {
        formattedContent =
          "No files found or unexpected format for this pull request."
      }
      break
    }
    case "list_tags": {
      const tagsData = parsedJson as ListTagsPayload
      if (Array.isArray(tagsData) && tagsData.length > 0) {
        tagsData.forEach((tag: ListTagsPayloadItem) => {
          let tagContent = `Tag: ${tag.name}\nCommit SHA: ${tag.commit.sha.substring(0, 7)}`
          newFragments.push({
            id: `${baseFragmentId}-tag-${tag.name}`,
            content: tagContent,
            source: {
              app: Apps.Github,
              docId: tag.name,
              title: `Tag: ${tag.name}`,
              entity: SystemEntity.SystemInfo,
              url: tag.commit.url,
            },
            confidence: 1.0,
          })
        })
        formattedContent = `Found ${tagsData.length} tags. Displaying up to ${tagsData.length}.`
      } else {
        formattedContent = "No tags found for this repository."
      }
      break
    }
    case "list_branches": {
      const branchesData = parsedJson as ListBranchesPayload
      if (Array.isArray(branchesData) && branchesData.length > 0) {
        branchesData.forEach((branch: ListBranchesPayloadItem) => {
          let branchContent = `Branch: ${branch.name}\nLast Commit SHA: ${branch.commit.sha.substring(0, 7)}`
          newFragments.push({
            id: `${baseFragmentId}-branch-${branch.name}`,
            content: branchContent,
            source: {
              app: Apps.Github,
              docId: branch.name,
              title: `Branch: ${branch.name}`,
              entity: SystemEntity.SystemInfo,
              url: branch.commit.url,
            },
            confidence: 1.0,
          })
        })
        formattedContent = `Found ${branchesData.length} branches. Displaying up to ${branchesData.length}.`
      } else {
        formattedContent = "No branches found for this repository."
      }
      break
    }
    case "get_issue_comments": {
      const commentsData = parsedJson as GetIssueCommentsPayload
      if (Array.isArray(commentsData) && commentsData.length > 0) {
        commentsData.forEach((comment: GetIssueCommentsPayloadItem) => {
          let commentContent = `Comment by ${comment.user?.login} on ${getRelativeTime(new Date(comment.created_at).getTime())}:\n${comment.body?.substring(0, 300) || "No content."}...`
          newFragments.push({
            id: `${baseFragmentId}-comment-${comment.id}`,
            content: commentContent,
            source: {
              app: Apps.Github,
              docId: String(comment.id),
              title: `Comment by ${comment.user?.login}`,
              entity: SystemEntity.SystemInfo,
              url: comment.html_url,
            },
            confidence: 1.0,
          })
        })
        formattedContent = `Found ${commentsData.length} comments. Displaying up to ${commentsData.length}.`
      } else {
        formattedContent = "No comments found for this issue."
      }
      break
    }
    case "search_users": {
      const usersData = parsedJson as SearchUsersPayload
      if (
        parsedJson.items &&
        Array.isArray(parsedJson.items) &&
        parsedJson.items.length > 0
      ) {
        parsedJson.items.forEach((user: any) => {
          let userContent = `User: ${user.login}\nProfile: ${user.html_url}`
          newFragments.push({
            id: `${baseFragmentId}-user-${user.id}`,
            content: userContent,
            source: {
              app: Apps.Github,
              docId: String(user.id),
              title: user.login,
              entity: SystemEntity.SystemInfo,
              url: user.html_url,
            },
            confidence: 0.9,
          })
        })
        formattedContent = `Found ${usersData.total_count} users. Displaying top ${parsedJson.items.length}.`
      } else {
        formattedContent = `Found ${usersData.total_count} users. No detailed items provided in this view.`
      }
      break
    }
    case "search_code": {
      const codeData = parsedJson as SearchCodePayload
      if (codeData.items && codeData.items.length > 0) {
        codeData.items.forEach((item: SearchCodePayloadItemsItem) => {
          let codeContent = `File: ${item.path}\nRepo: ${item.repository.full_name}\nSHA: ${item.sha.substring(0, 7)}...`
          newFragments.push({
            id: `${baseFragmentId}-code-${item.sha}`,
            content: codeContent,
            source: {
              app: Apps.Github,
              docId: item.sha,
              title: `${item.name} in ${item.repository.full_name}`,
              entity: SystemEntity.SystemInfo,
              url: item.html_url,
            },
            confidence: 0.9,
          })
        })
        formattedContent = `Found ${codeData.total_count} code results. Displaying top ${codeData.items.length}.`
      } else {
        formattedContent = "No code found matching your query."
      }
      break
    }
    case "get_file_contents": {
      if (Array.isArray(parsedJson)) {
        const dirData = parsedJson as GetFileContentsPayload
        dirData.forEach((item: GetFileContentsPayloadItem) => {
          let itemContent = `Item: ${item.name} (${item.type})`
          newFragments.push({
            id: `${baseFragmentId}-item-${item.sha}`,
            content: itemContent,
            source: {
              app: Apps.Github,
              docId: item.sha,
              title: item.name,
              entity: SystemEntity.SystemInfo,
              url: item.html_url,
            },
            confidence: 1.0,
          })
        })
        formattedContent = `Listed ${dirData.length} items in directory.`
      } else if (parsedJson.type === "file" && parsedJson.content) {
        const fileData = parsedJson as {
          name: string
          path: string
          sha: string
          html_url: string
          content: string
          encoding: string
        }
        let fileContentDecoded =
          fileData.encoding === "base64"
            ? Buffer.from(fileData.content, "base64").toString("utf-8")
            : fileData.content
        formattedContent = `File: ${fileData.name}\nPath: ${fileData.path}\n\n${fileContentDecoded.substring(0, 500)}...`
        newFragments.push({
          id: `${baseFragmentId}-file-${fileData.sha}`,
          content: formattedContent,
          source: {
            app: Apps.Github,
            docId: fileData.sha,
            title: fileData.name,
            entity: SystemEntity.SystemInfo,
            url: fileData.html_url,
          },
          confidence: 1.0,
        })
      } else {
        formattedContent = "File content not available or unexpected format."
      }
      break
    }
    case "get_pull_request_reviews": {
      const reviewsData = parsedJson as GetPullRequestReviewsPayload
      if (Array.isArray(reviewsData) && reviewsData.length > 0) {
        reviewsData.forEach((review: GetPullRequestReviewsPayloadItem) => {
          let reviewContent = `Review by ${review.user?.login} (${review.state}) on ${getRelativeTime(new Date(review.submitted_at).getTime())}:\n${review.body?.substring(0, 300) || "No review body."}...`
          newFragments.push({
            id: `${baseFragmentId}-review-${review.id}`,
            content: reviewContent,
            source: {
              app: Apps.Github,
              docId: String(review.id),
              title: `Review by ${review.user?.login} (${review.state})`,
              entity: SystemEntity.SystemInfo,
              url: review.html_url,
            },
            confidence: 1.0,
          })
        })
        formattedContent = `Found ${reviewsData.length} reviews. Displaying up to ${reviewsData.length}.`
      } else {
        formattedContent = "No reviews found for this pull request."
      }
      break
    }
    default:
      loggerWithChild({ email: emailSub }).info(
        `Using fallback formatting for tool ${toolName}`,
      )
      let mainContentParts = []
      if (parsedJson.title) mainContentParts.push(`Title: ${parsedJson.title}`)
      if (parsedJson.body) mainContentParts.push(`Body: ${parsedJson.body}`)
      if (parsedJson.name) mainContentParts.push(`Name: ${parsedJson.name}`)
      if (parsedJson.description)
        mainContentParts.push(`Description: ${parsedJson.description}`)

      if (mainContentParts.length > 0) {
        formattedContent = mainContentParts.join("\n")
      } else {
        formattedContent = `Tool Response: ${flattenObject(parsedJson)
          .map(([key, value]) => `- ${key}: ${value}`)
          .join("\n")}`
      }

      newFragments.push({
        id: `${baseFragmentId}-generic`,
        content: formattedContent,
        source: {
          app: Apps.Github,
          docId: `${toolName}-response`,
          title: `Response from ${toolName}`,
          entity: SystemEntity.SystemInfo,
          url: parsedJson.html_url || parsedJson.url || undefined,
        },
        confidence: 0.8,
      })
  }
  return { formattedContent, newFragments }
}

export interface ToolDefinition {
  name: string
  description: string
  params?: Array<{
    name: string
    type: string
    required: boolean
    description: string
  }>
}

export type ToolParameter = {
  name: string
  type: string
  required: boolean
  description: string
}

export function formatToolDescription(tool: ToolDefinition): string {
  let description = `${tool.name}: ${tool.description}`

  if (tool.params && tool.params.length > 0) {
    description += `\n      Params:`
    tool.params.forEach((param) => {
      const requiredText = param.required ? "required" : "optional"
      description += `\n        - ${param.name} (${requiredText}): ${param.description}`
    })
  }

  return description
}

export function formatToolsSection(
  tools: Record<string, ToolDefinition>,
  sectionTitle: string,
): string {
  const toolDescriptions = Object.values(tools)
    .map((tool, index) => `    ${index + 1}. ${formatToolDescription(tool)}`)
    .join("\n")

  return `    **${sectionTitle}:**\n${toolDescriptions}`
}

export function modifyToolParameter(
  tool: ToolDefinition,
  paramName: string,
  updates: Partial<ToolParameter>,
): ToolDefinition {
  if (!tool.params) return tool

  return {
    ...tool,
    params: tool.params.map((param) =>
      param.name === paramName ? { ...param, ...updates } : param,
    ),
  }
}

export function addToolParameter(
  tool: ToolDefinition,
  newParam: ToolParameter,
): ToolDefinition {
  return {
    ...tool,
    params: [...(tool.params || []), newParam],
  }
}

export function removeToolParameter(
  tool: ToolDefinition,
  paramName: string,
): ToolDefinition {
  if (!tool.params) return tool

  return {
    ...tool,
    params: tool.params.filter((param) => param.name !== paramName),
  }
}

// Import the AgentTool type to support conversion utilities
export interface AgentToolParameter {
  type: string
  description: string
  required: boolean
}

// Utility function to convert ToolDefinition to AgentTool parameters format
export function convertToAgentToolParameters(
  toolDef: ToolDefinition,
): Record<string, AgentToolParameter> {
  if (!toolDef.params || toolDef.params.length === 0) {
    return {}
  }

  return toolDef.params.reduce(
    (acc, param) => {
      acc[param.name] = {
        type: param.type,
        description: param.description,
        required: param.required,
      }
      return acc
    },
    {} as Record<string, AgentToolParameter>,
  )
}

// Utility function to create an AgentTool from a ToolDefinition (without execute function)
export function createAgentToolFromDefinition(
  toolDef: ToolDefinition,
  executeFunction: (params: any, ...args: any[]) => Promise<any>,
): any {
  return {
    name: toolDef.name,
    description: toolDef.description,
    parameters: convertToAgentToolParameters(toolDef),
    execute: executeFunction,
  }
}
