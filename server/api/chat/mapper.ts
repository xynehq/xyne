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

export const internalTools: Record<string, ToolDefinition> = {
  [XyneTools.GetUserInfo]: {
    name: XyneTools.GetUserInfo,
    description:
      "Retrieves comprehensive information about the current authenticated user and their workspace environment. This tool provides essential context including user identity (name, email), organizational details (company affiliation), current system time, and workspace configuration. Perfect for personalizing responses, understanding user context, and providing time-sensitive information. This tool requires no parameters and automatically returns current user session data.",
    params: [],
  },
  [XyneTools.MetadataRetrieval]: {
    name: XyneTools.MetadataRetrieval,
    description:
      "Advanced structured data retrieval tool that searches and filters items based on comprehensive metadata criteria across integrated applications. This tool excels at precise, targeted searches within specific applications (Gmail, Google Drive, Google Calendar, Slack, etc.) using metadata filters like time ranges, entity types, and semantic intent. Ideal for queries requiring exact application targeting, complex email filtering with sender/recipient analysis, time-bounded searches, and structured data exploration. Use when you need precise control over search scope and when semantic content search is less important than metadata-based filtering.",
    params: [
      {
        name: "from",
        type: "string",
        required: false,
        description: `Define the temporal start boundary for search results in UTC format (${config.llmTimeFormat}). This parameter establishes the earliest timestamp for returned items. Essential for time-sensitive queries like "emails from last week", "meetings since Monday", or "documents created after January 1st". The system intelligently handles relative time expressions and converts them to absolute timestamps.`,
      },
      {
        name: "to",
        type: "string",
        required: false,
        description: `Define the temporal end boundary for search results in UTC format (${config.llmTimeFormat}). This parameter establishes the latest timestamp for returned items. Critical for time-bounded queries like "emails until yesterday", "events before next week", or "files modified before the deadline". Works in conjunction with 'from' parameter to create precise time windows.`,
      },
      {
        name: "app",
        type: "string",
        required: true,
        description: `
          Specify the target application for search operations. MUST BE EXACTLY ONE OF THESE VALUES (case-sensitive):
          - '${Apps.Gmail}' - For email communications, messages, threads, and email-related data
          - '${Apps.GoogleCalendar}' - For calendar events, meetings, appointments, and scheduling data  
          - '${Apps.GoogleDrive}' - For cloud storage files, documents, folders, and collaborative content
          - '${Apps.GoogleWorkspace}' - For organizational contacts, people directory, and workspace members
          - '${Apps.Slack}' - For Slack messages, channels, threads, and team communications
          - '${Apps.DataSource}' - For custom data sources and external integrations
        `,
      },
      {
        name: "entity",
        type: "string",
        required: false,
        description: `
          Refine search scope by specifying the exact data entity type within the target application. MUST BE EXACTLY ONE OF THESE VALUES (case-sensitive):
          - Gmail entities: '${MailEntity.Email}' for email messages and conversations
          - Drive entities: '${DriveEntity.Docs}' (Google Docs), '${DriveEntity.Sheets}' (Spreadsheets), '${DriveEntity.Slides}' (Presentations), '${DriveEntity.PDF}' (PDF files), '${DriveEntity.Folder}' (directory structures)
          - Calendar entities: '${CalendarEntity.Event}' for calendar events and meetings
          - Workspace entities: '${GooglePeopleEntity.Contacts}' for contact information and profiles
          - Slack entities: 'message' (chat messages), 'user' (user profiles), 'channel' (channel information)
          `,
      },
      {
        name: "filter_query",
        type: "string",
        required: false,
        description: "Semantic keyword filter for content-based refinement. Use natural language terms, specific phrases, or domain-specific keywords that should appear in the search results. This parameter performs intelligent matching across titles, content, descriptions, and other searchable text fields within the specified app and entity context.",
      },
      {
        name: "intent",
        type: "object",
        required: false,
        description: `
          Advanced email communication filtering with intelligent resolution of names, organizations, and email addresses. Supports complex multi-participant email queries with automatic name-to-email mapping.
          Structure: {from?: string[], to?: string[], cc?: string[], bcc?: string[]}
          - Each field accepts arrays containing email addresses, full names, first names, or organization names
          - System performs intelligent resolution: 'John Doe' → 'john.doe@company.com', 'OpenAI' → all known OpenAI email addresses
          - Supports mixed queries: {from: ['john@company.com', 'Sarah Wilson', 'Linear'], to: ['team-leads']}
          - Use cases: "emails from John and Linear team", "messages to project managers", "communications involving external partners"
          Example: {from: ['john@company.com', 'Sarah'], to: ['team@company.com'], cc: ['manager@company.com']}
          `,
      },
      {
        name: "limit",
        type: "number",
        required: false,
        description: "Maximum number of results to return in a single response. Controls result set size for performance optimization and relevant result focus. Default values vary by application type. Use smaller limits (10-50) for detailed reviews, larger limits (100-500) for comprehensive analysis.",
      },
      {
        name: "offset",
        type: "number",
        required: false,
        description: "Number of results to skip from the beginning, enabling pagination through large result sets. Essential for browsing through extensive search results systematically. Combine with 'limit' for efficient data exploration. Example: offset=50, limit=25 retrieves results 51-75.",
      },
      {
        name: "order_direction",
        type: "string",
        required: false,
        description:
          "Result ordering preference by timestamp. Use 'desc' (default) for newest-first chronological order, ideal for recent activity review. Use 'asc' for oldest-first ordering, perfect for historical analysis, project timelines, or sequential data review.",
      },
      {
        name: "excludedIds",
        type: "array",
        required: false,
        description: "Array of document/item identifiers to exclude from search results. Useful for removing known irrelevant items, avoiding duplicate processing, or filtering out specific content. Accepts internal document IDs, file IDs, or message IDs depending on the target application.",
      },
    ],
  },
  [XyneTools.Search]: {
    name: XyneTools.Search,
    description: "Universal semantic content search engine that performs intelligent, full-text searches across all integrated data sources simultaneously. This tool leverages advanced natural language processing and semantic understanding to find relevant information regardless of source application. Ideal for exploratory searches, content discovery, cross-platform information retrieval, and when you need to find information but aren't sure which specific application contains it. Use this tool for broad, content-focused queries where semantic relevance is more important than metadata precision.",
    params: [
      {
        name: "filter_query",
        type: "string",
        required: true,
        description: "Natural language search query that describes the information you're seeking. This parameter supports complex semantic queries, conceptual searches, specific phrases, technical terms, and contextual keywords. The system performs intelligent content matching across documents, emails, messages, and other text-based content using advanced NLP techniques.",
      },
      {
        name: "limit",
        type: "number",
        required: false,
        description: "Maximum number of search results to return, controlling response size and processing time. Higher limits provide comprehensive coverage but may include less relevant results. Recommended values: 20-50 for focused searches, 100+ for comprehensive exploration.",
      },
      {
        name: "order_direction",
        type: "string",
        required: false,
        description:
          "Chronological sorting preference for search results. 'desc' returns newest content first (default), ideal for finding recent information. 'asc' returns oldest content first, useful for historical research, project origins, or timeline analysis.",
      },
      {
        name: "offset",
        type: "number",
        required: false,
        description: "Pagination offset for navigating through large result sets. Specifies how many results to skip from the beginning, enabling systematic exploration of comprehensive search results. Essential for reviewing all relevant information when initial results exceed the limit.",
      },
      {
        name: "excludedIds",
        type: "array",
        required: false,
        description: "Collection of unique identifiers for items to exclude from search results. Useful for refining searches by removing known irrelevant content, avoiding previously processed items, or filtering out specific documents/messages based on prior search iterations.",
      },
    ],
  },
  [XyneTools.Conversational]: {
    name: XyneTools.Conversational,
    description:
      "Intelligent conversational query classifier and response handler for casual interactions, greetings, social queries, and basic informational requests that don't require data retrieval. This tool identifies and responds to conversational patterns including social greetings (Hello, Hi, How are you), time zone queries (What time is it in Tokyo?), simple calculations, weather questions, and other casual interactions. Use this tool when the user's intent is social communication rather than data search or retrieval. The tool automatically handles response generation without requiring additional parameters.",
    params: [],
  },
}

export const slackTools: Record<string, ToolDefinition> = {
  [XyneTools.getSlackThreads]: {
    name: XyneTools.getSlackThreads,
    description:
      "Advanced Slack thread conversation retrieval tool designed to search and extract threaded message discussions with full conversational context. This tool specializes in finding and assembling complete conversation threads, including parent messages, replies, reactions, and thread metadata. Perfect for understanding discussion context, tracking decision-making processes, analyzing conversation flows, and gathering comprehensive team communication history. Ideal for queries like 'show me the discussion about the project launch' or 'find threads where technical decisions were made'.",
    params: [
      {
        name: "filter_query",
        type: "string",
        required: false,
        description: "Semantic search keywords to identify relevant thread conversations. Use natural language terms, project names, technical concepts, or discussion topics to find threads containing specific subjects. The system performs intelligent matching across thread content, participant names, and message context to locate the most relevant threaded discussions.",
      },
      {
        name: "limit",
        type: "number",
        required: false,
        description: "Maximum number of thread conversations to retrieve in a single response. Controls the breadth of results returned. Recommended values: 10-25 for focused thread analysis, 50+ for comprehensive conversation discovery. Each result represents a complete thread with all its constituent messages.",
      },
      {
        name: "offset",
        type: "number",
        required: false,
        description: "Pagination parameter to skip a specified number of thread results from the beginning. Essential for browsing through extensive thread collections systematically. Use in combination with 'limit' to navigate large conversation datasets efficiently.",
      },
      {
        name: "order_direction",
        type: "string",
        required: false,
        description:
          "Chronological ordering of thread results based on thread initiation time. 'desc' (default) shows newest threads first, ideal for recent conversation analysis. 'asc' shows oldest threads first, useful for historical discussion review and project timeline analysis.",
      },
    ],
  },
  [XyneTools.getSlackRelatedMessages]: {
    name: XyneTools.getSlackRelatedMessages,
    description: "Comprehensive Slack message search and retrieval system with advanced filtering capabilities for targeted channel-based communication analysis. This tool provides granular control over message discovery within specific channels, supporting complex queries involving user-specific messages, time-bounded searches, content filtering, and contextual message retrieval. Essential for channel-focused investigations, user activity analysis, project communication tracking, and temporal message exploration within defined Slack workspaces.",
    params: [
      {
        name: "channel_name",
        type: "string",
        required: true,
        description: "Exact name or identifier of the target Slack channel for message retrieval. Accepts channel names (without # prefix), channel IDs, or channel display names. This parameter defines the scope boundary for all message searches. Examples: 'general', 'project-alpha', 'engineering-team'.",
      },
      {
        name: "filter_query",
        type: "string",
        required: false,
        description: "Content-based search filter using natural language keywords, phrases, or semantic concepts. The system performs intelligent text matching across message content, file names, link descriptions, and embedded content. Supports complex queries like technical terms, project names, or contextual discussions.",
      },
      {
        name: "user_email",
        type: "string",
        required: false,
        description: "Email address of a specific Slack user to filter messages by authorship. When specified, only messages sent by this user within the target channel will be returned. Useful for tracking individual contributions, finding specific user's communications, or analyzing participation patterns.",
      },
      {
        name: "limit",
        type: "number",
        required: false,
        description: "Maximum number of individual messages to retrieve from the specified channel. Controls result volume and response processing time. Recommended values: 25-100 for focused message analysis, 200+ for comprehensive channel history review.",
      },
      {
        name: "offset",
        type: "number",
        required: false,
        description: "Number of messages to skip from the beginning of the result set, enabling systematic pagination through large message collections. Critical for exploring extensive channel histories without overwhelming single responses.",
      },
      {
        name: "order_direction",
        type: "string",
        required: false,
        description:
          "Temporal ordering preference for message results. 'desc' (default) returns newest messages first, optimal for recent activity review. 'asc' returns oldest messages first, ideal for chronological analysis, project timelines, and historical communication patterns.",
      },
      {
        name: "from",
        type: "string",
        required: false,
        description: `Temporal start boundary for message search in UTC format (${config.llmTimeFormat}). Establishes the earliest timestamp for returned messages. Essential for time-scoped analysis like 'messages from last sprint', 'communications since project start', or 'activity after the announcement'. Works with intelligent relative time parsing.`,
      },
      {
        name: "to",
        type: "string",
        required: false,
        description: `Temporal end boundary for message search in UTC format (${config.llmTimeFormat}). Defines the latest timestamp for returned messages. Critical for bounded time analysis like 'messages until the deadline', 'communications before the meeting', or 'activity during the project phase'. Combines with 'from' parameter for precise time window definition.`,
      },
    ],
  },
  [XyneTools.getUserSlackProfile]: {
    name: XyneTools.getUserSlackProfile,
    description: "Comprehensive Slack user profile information retrieval tool that fetches detailed user account data, workspace membership details, and professional information from Slack directories. This tool provides essential user context including display names, roles, team affiliations, status information, contact details, and workspace-specific metadata. Invaluable for user identification, team member discovery, contact information lookup, and understanding organizational structure within Slack workspaces. Perfect for queries involving user verification, team composition analysis, and contact management.",
    params: [
      {
        name: "user_email",
        type: "string",
        required: true,
        description:
          "Primary email address associated with the target user's Slack account. This serves as the unique identifier for user profile lookup across workspace directories. Must be the exact email address used for Slack account registration. The system will retrieve comprehensive profile information including display name, real name, title, department, phone numbers, and workspace-specific settings associated with this email address.",
      },
    ],
  },
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

export function createCustomToolSet(options: {
  internal?: Record<string, ToolDefinition>
  slack?: Record<string, ToolDefinition>
  excludeInternal?: string[]
  excludeSlack?: string[]
}): {
  internal: Record<string, ToolDefinition>
  slack: Record<string, ToolDefinition>
} {
  const {
    internal: customInternal = {},
    slack: customSlack = {},
    excludeInternal = [],
    excludeSlack = [],
  } = options

  // Filter out excluded tools and merge with custom tools
  const filteredInternal = Object.fromEntries(
    Object.entries(internalTools).filter(
      ([key]) => !excludeInternal.includes(key),
    ),
  )
  const filteredSlack = Object.fromEntries(
    Object.entries(slackTools).filter(([key]) => !excludeSlack.includes(key)),
  )

  return {
    internal: { ...filteredInternal, ...customInternal },
    slack: { ...filteredSlack, ...customSlack },
  }
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

// Helper function to get tool definition by name
export function getToolDefinition(
  toolName: string,
): ToolDefinition | undefined {
  return internalTools[toolName] || slackTools[toolName]
}

// Helper to create parameters object for a specific tool
export function getToolParameters(
  toolName: string,
): Record<string, AgentToolParameter> {
  const toolDef = getToolDefinition(toolName)
  return toolDef ? convertToAgentToolParameters(toolDef) : {}
}

// Example usage functions for common customizations
export function createSearchOnlyTools() {
  return createCustomToolSet({
    excludeInternal: [XyneTools.Conversational],
    excludeSlack: [XyneTools.getUserSlackProfile],
  })
}

export function createMinimalToolSet() {
  return createCustomToolSet({
    excludeInternal: [XyneTools.Conversational],
    excludeSlack: Object.keys(slackTools), // Exclude all slack tools
  })
}

// Example: How to create an AgentTool using the mapper definitions
export function createMetadataRetrievalAgentTool(
  executeFunction: (params: any, ...args: any[]) => Promise<any>,
) {
  const toolDef = internalTools[XyneTools.MetadataRetrieval]
  return createAgentToolFromDefinition(toolDef, executeFunction)
}

// Example: Get just the parameters for an existing tool
export function getMetadataRetrievalParameters() {
  return getToolParameters(XyneTools.MetadataRetrieval)
}

// Example: Create a customized version of a tool with modified parameters
export function createCustomMetadataRetrievalTool(
  executeFunction: (params: any, ...args: any[]) => Promise<any>,
  appOptions: string,
) {
  let toolDef = { ...internalTools[XyneTools.MetadataRetrieval] }

  // Modify the app parameter description to include specific app options
  toolDef = modifyToolParameter(toolDef, "app", {
    description: `MUST BE EXACTLY ONE OF ${appOptions}.`,
  })

  return createAgentToolFromDefinition(toolDef, executeFunction)
}

// Helper function to validate parameter types match the tool definition
export function validateToolParams<
  T extends keyof typeof internalTools | keyof typeof slackTools,
>(
  toolName: T,
  params: any,
): params is T extends keyof typeof internalTools
  ? MetadataRetrievalParams | SearchParams | ConversationalParams
  : SlackThreadsParams | SlackRelatedMessagesParams | SlackUserProfileParams {
  const toolDef = getToolDefinition(toolName as string)
  if (!toolDef || !toolDef.params) return true

  // Basic validation - check required parameters exist
  for (const param of toolDef.params) {
    if (param.required && !(param.name in params)) {
      console.warn(
        `Missing required parameter: ${param.name} for tool: ${toolName}`,
      )
      return false
    }
  }

  return true
}

// Function to create a parameter object with the correct type
export function createToolParams(
  toolName: string,
  params: Record<string, any>,
): any {
  // Runtime validation
  if (!validateToolParams(toolName as any, params)) {
    throw new Error(`Invalid parameters for tool: ${toolName}`)
  }

  return params
}
