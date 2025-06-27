import type { Context } from "hono"
import {
  ingestionMailErrorsTotal,
  totalAttachmentError,
  totalAttachmentIngested,
  totalGmailToBeIngestedCount,
  totalIngestedMails,
  totalSkippedMails,
} from "@/metrics/google/gmail-metrics"
import {
  AuthType,
  CalendarEntity,
  DriveEntity,
  GooglePeopleEntity,
} from "@/shared/types"
import { OperationStatus } from "@/types"
import { metadataFiles } from "./google/metadata_metrics"
import {
  blockedFilesTotal,
  totalDriveFilesToBeIngested,
  totalIngestedFiles,
} from "./google/google-drive-file-metrics"
import { DriveMime } from "@/integrations/google/utils"

interface UpdateMetricsPayload {
  email: string
  messageCount: number
  attachmentCount: number
  failedMessages: number
  failedAttachments: number
  totalMails: number
  skippedMail: number
  eventsCount: number
  contactsCount: number
  pdfCount: number
  docCount: number
  sheetsCount: number
  slidesCount: number
  fileCount: number
  totalDriveFiles: number
  blockedPdfs: number
}

export const updateMetricsFromThread = ({
  email,
  messageCount,
  attachmentCount,
  failedMessages,
  failedAttachments,
  totalMails,
  skippedMail,
  eventsCount,
  contactsCount,
  pdfCount,
  docCount,
  sheetsCount,
  slidesCount,
  fileCount,
  totalDriveFiles,
  blockedPdfs,
}: UpdateMetricsPayload) => {
  totalIngestedMails.inc(
    {
      email: email,
      account_type: AuthType.ServiceAccount,
      status: OperationStatus.Success,
    },
    messageCount,
  )
  totalAttachmentIngested.inc(
    {
      email: email,
      account_type: AuthType.ServiceAccount,
      status: OperationStatus.Success,
    },
    attachmentCount,
  )
  ingestionMailErrorsTotal.inc(
    {
      email: email,
      account_type: AuthType.ServiceAccount,
      status: OperationStatus.Failure,
    },
    failedMessages,
  )
  totalAttachmentError.inc(
    {
      email: email,
      account_type: AuthType.ServiceAccount,
      status: OperationStatus.Failure,
    },
    failedAttachments,
  )
  totalGmailToBeIngestedCount.inc(
    {
      email: email,
      account_type: AuthType.ServiceAccount,
      status: OperationStatus.Success,
    },
    totalMails,
  )
  totalSkippedMails.inc(
    {
      email: email,
      account_type: AuthType.ServiceAccount,
      status: OperationStatus.Success,
    },
    skippedMail,
  )
  metadataFiles.inc(
    {
      file_type: GooglePeopleEntity.Contacts,
      mime_type: "google_people",
      email: email,
      status: OperationStatus.Success,
    },
    contactsCount,
  )
  metadataFiles.inc(
    {
      file_type: CalendarEntity.Event,
      mime_type: "google_calendar_events",
      status: OperationStatus.Success,
      email: email,
    },
    eventsCount,
  )
  totalIngestedFiles.inc(
    {
      mime_type: DriveMime.PDF,
      status: OperationStatus.Success,
      email: email,
      file_type: DriveEntity.PDF,
    },
    pdfCount,
  )
  totalIngestedFiles.inc(
    {
      mime_type: DriveMime.Docs,
      status: OperationStatus.Success,
      email: email,
      file_type: DriveEntity.Docs,
    },
    docCount,
  )
  totalIngestedFiles.inc(
    {
      mime_type: DriveMime.Sheets,
      status: OperationStatus.Success,
      email: email,
      file_type: DriveEntity.Sheets,
    },
    sheetsCount,
  )
  totalIngestedFiles.inc(
    {
      mime_type: DriveMime.Slides,
      status: OperationStatus.Success,
      email: email,
      file_type: DriveEntity.Slides,
    },
    slidesCount,
  )
  totalIngestedFiles.inc(
    {
      mime_type: "application/vnd.google-apps.file",
      status: OperationStatus.Success,
      email: email,
      file_type: DriveEntity.Misc,
    },
    fileCount,
  )
  totalDriveFilesToBeIngested.inc(
    {
      email: email,
      file_type: DriveEntity.Misc,
      status: OperationStatus.Success,
    },
    totalDriveFiles,
  )
  blockedFilesTotal.inc(
    {
      email: email,
      file_type: DriveEntity.PDF,
      mime_type: DriveMime.PDF,
      status: OperationStatus.Cancelled,
    },
    blockedPdfs,
  )

  console.log("Completed Adding Metrics")
}
