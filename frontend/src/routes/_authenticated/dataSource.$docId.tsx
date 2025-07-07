import { DataSourceViewer } from "@/components/DataSourceViewer"
import { errorComponent } from "@/components/error"
import { createFileRoute, useLoaderData } from "@tanstack/react-router"
import { api } from "@/api"
import {
  VespaGetResult,
  dataSourceFileSchema,
  VespaDataSourceFile,
  Apps,
} from "shared/types"

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
    return <div>Error: No data received</div>
  }

  if ("error" in data) {
    const errorMessage =
      "message" in data ? data.message : "Unknown error occurred"
    return <div>Error loading data source: {errorMessage as string}</div>
  }

  if ((data.fields as VespaDataSourceFile).app !== Apps.DataSource) {
    console.log("Invalid data source schema:", data)
    return <div>Error: Invalid data source schema</div>
  }

  const fields = data.fields as VespaDataSourceFile
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
