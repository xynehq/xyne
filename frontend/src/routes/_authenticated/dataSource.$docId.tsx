import { DataSourceViewer } from "@/components/DataSourceViewer"
import { errorComponent } from "@/components/error"
import { createFileRoute, useLoaderData } from "@tanstack/react-router"
import { api } from "@/api"
import { VespaGetResult, VespaDataSourceFile, Apps } from "shared/types"

type LoaderData = VespaGetResult | { error: any } | null

export const Route = createFileRoute("/_authenticated/dataSource/$docId")({
  component: RouteComponent,
  loader: async ({ params }): Promise<LoaderData> => {
    try {
      const res = await api.datasources[":docId"].$get({
        param: {
          docId: params.docId,
        },
      })

      if (!res.ok) {
        const errorData = (await res.json()) as any
        return errorData
      }

      return (await res.json()) as VespaGetResult
    } catch (error) {
      return { error }
    }
  },
  errorComponent: errorComponent,
})

function RouteComponent() {
  const data = useLoaderData({
    from: "/_authenticated/dataSource/$docId",
  }) as LoaderData

  if (!data) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="text-red-500 text-lg font-semibold mb-2">
            No Data Received
          </div>
          <p className="text-gray-600">
            The data source file could not be loaded.
          </p>
        </div>
      </div>
    )
  }

  if ("error" in data) {
    const errorData = data as any
    let errorTitle = "Error Loading Data Source"
    let errorMessage = "An unknown error occurred"
    let errorDetails = ""

    if (errorData.error && errorData.message) {
      switch (errorData.error) {
        case "Not Found":
          errorTitle = "Data Source File Not Found"
          errorMessage =
            "The requested data source file does not exist or has been deleted."
          break
        case "Forbidden":
          errorTitle = "Access Denied"
          errorMessage =
            "You don't have permission to view this data source file."
          errorDetails =
            "This file may be part of an agent that hasn't been shared with you."
          break
        case "Unauthorized":
          errorTitle = "Authentication Required"
          errorMessage = "You don't have access to this data source file."
          break
        case "Bad Request":
          errorTitle = "Invalid Request"
          errorMessage = errorData.message || "The request was malformed."
          break
        default:
          errorTitle = errorData.error
          errorMessage = errorData.message
      }
    } else if (errorData.message) {
      errorMessage = errorData.message
    } else if (errorData.error) {
      errorMessage = errorData.error.message || "A network error occurred"
      errorDetails = "Please check your internet connection and try again."
    }

    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="max-w-md text-center">
          <div className="text-red-500 text-xl font-bold mb-3">
            {errorTitle}
          </div>
          <p className="text-gray-700 mb-2">{errorMessage}</p>
          {errorDetails && (
            <p className="text-gray-500 text-sm">{errorDetails}</p>
          )}
        </div>
      </div>
    )
  }

  if (!data.fields) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="text-red-500 text-lg font-semibold mb-2">
            Invalid Data Structure
          </div>
          <p className="text-gray-600">
            The data source file data is malformed.
          </p>
        </div>
      </div>
    )
  }

  const fields = data.fields as VespaDataSourceFile

  if (fields.app !== Apps.DataSource) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="text-red-500 text-lg font-semibold mb-2">
            Invalid Data Source
          </div>
          <p className="text-gray-600">
            This file is not a valid data source document.
          </p>
        </div>
      </div>
    )
  }

  const fileName = fields.fileName || "Untitled"
  const description = fields.description || "No description available"
  const textContent = fields.chunks?.join("\n\n") || "No content available"

  return (
    <DataSourceViewer
      id={fields.docId}
      title={fileName}
      description={description}
      text={textContent}
      uploadedBy={fields.uploadedBy}
      createdAt={fields.createdAt}
      fileSize={fields.fileSize}
      mimeType={fields.mimeType}
    />
  )
}
