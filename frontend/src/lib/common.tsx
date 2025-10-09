import {
  Folder,
  Users,
  Paperclip,
  FileText,
  CalendarDays,
  PlugZap,
  Github,
  BookOpen,
  Globe,
  File as FileIcon,
} from "lucide-react" // Added FileText, CalendarDays, PlugZap, Github, BookOpen, File
import DocsSvg from "@/assets/docs.svg" // Added this line
import SlidesSvg from "@/assets/slides.svg"
import SheetsSvg from "@/assets/sheets.svg"
import DriveSvg from "@/assets/drive.svg"
// import NotionPageSvg from "@/assets/notionPage.svg"
import Gmail from "@/assets/gmail.svg"
import Docx from "@/assets/docx.svg"
import Pdf from "@/assets/pdf.svg"
import Slides from "@/assets/slides.svg"
import Image from "@/assets/images.svg"
import GoogleCalendarSvg from "@/assets/googleCalendar.svg"
import SlackSvg from "@/assets/slack.svg"

// Collection icon imports for file upload
import TextIcon from "@/assets/collectionIcons/text.svg"
import ImageIcon from "@/assets/collectionIcons/image.svg"
import PdfIcon from "@/assets/collectionIcons/pdf.svg"
import DocumentIcon from "@/assets/collectionIcons/document.svg"
import SpreadsheetIcon from "@/assets/collectionIcons/spreadsheet.svg"
import PresentationIcon from "@/assets/collectionIcons/ppt.svg"
import type { Entity } from "shared/types"
import {
  Apps,
  DriveEntity,
  GooglePeopleEntity,
  // NotionEntity,
  CalendarEntity,
  isMailAttachment,
  ConnectorType,
  SystemEntity,
  DataSourceEntity,
  WebSearchEntity,
  FileType,
} from "shared/types"
import { LoadingSpinner } from "@/routes/_authenticated/admin/integrations/google"
import { getFileType } from "shared/fileUtils"

// Define placeholder entities if they don't exist in shared/types
const PdfEntity = { Default: "pdf_default" } as const
const EventEntity = { Default: "event_default" } as const

export const getIcon = (
  app: Apps | string, // Allow string for generic types like 'pdf', 'event'
  entity: Entity | string, // Allow string for generic types
  size?: { w: number; h: number; mr: number; ml?: number },
) => {
  let classNameVal = ""
  if (size) {
    classNameVal = `h-[${size.h}px] w-[${size.w}px] mr-[${size.mr}px]`
    if (size.ml) {
      classNameVal += ` ml-[${size.ml}px]`
    }
  } else {
    classNameVal = "h-[12px] w-[12px] mr-[10px]"
  }
  if (app === Apps.GoogleDrive) {
    // ...existing GoogleDrive cases...
    if (entity === DriveEntity.Docs) {
      return <img className={classNameVal} src={DocsSvg} />
    } else if (entity === DriveEntity.Sheets) {
      return <img className={classNameVal} src={SheetsSvg} />
    } else if (entity === DriveEntity.Presentation) {
      return <img className={classNameVal} src={SlidesSvg} />
    } else if (entity === DriveEntity.Folder) {
      return (
        <Folder
          className="h-[17px] w-[17px] mr-2 dark:fill-[#F1F3F4]"
          fill="rgb(196, 199, 197)"
          stroke="none"
        />
      )
    } else if (
      entity === GooglePeopleEntity.Contacts ||
      entity === GooglePeopleEntity.OtherContacts
    ) {
      return (
        <Users
          stroke="#464B53"
          size={12}
          className="mr-[10px] dark:stroke-[#F1F3F4]"
        />
      )
    } else if (entity === DriveEntity.WordDocument) {
      return <img className={classNameVal} src={Docx} />
    } else if (entity === DriveEntity.PDF) {
      return <img className={classNameVal} src={Pdf} />
    } else if (entity === DriveEntity.Slides) {
      return <img className={classNameVal} src={Slides} />
    } else if (entity === DriveEntity.Image) {
      return <img className={classNameVal} src={Image} />
    } else {
      return <img className={classNameVal} src={DriveSvg} />
    }
  } else if (app === Apps.GoogleWorkspace) {
    return <Users size={12} className="mr-[10px]" />
  } else if (app === Apps.Gmail) {
    // ...existing Gmail cases...
    if (isMailAttachment(entity as Entity)) {
      return (
        <Paperclip
          className={`${classNameVal} dark:fill-[#F1F3F4]`}
          fill="rgb(196, 199, 197)"
        />
      )
    }
    return <img className={classNameVal} src={Gmail} />
    // } else if (app === Apps.Notion) {
    //   // ...existing Notion cases...
    //   if (entity === NotionEntity.Page) {
    //     return <img className={classNameVal} src={NotionPageSvg} />
    //   }
  } else if (app === Apps.GoogleCalendar) {
    // ...existing GoogleCalendar cases...
    if (entity === CalendarEntity.Event) {
      return <img className={classNameVal} src={GoogleCalendarSvg} />
    }
  } else if (app === Apps.Slack) {
    // ...existing Slack cases...
    return <img className={classNameVal} src={SlackSvg} />
  } else if (app === "pdf" || entity === PdfEntity.Default) {
    // Added generic PDF
    return <img className={classNameVal} src={Pdf} />
  } else if (app === "event" || entity === EventEntity.Default) {
    // Added generic Event
    return <CalendarDays size={12} className={classNameVal} />
  } else if (app === Apps.DataSource && entity === "file") {
    return <FileText size={size?.w || 12} className={classNameVal} />
  } else if (app === Apps.KnowledgeBase && entity === SystemEntity.SystemInfo) {
    return (
      <BookOpen
        size={size?.w || 12}
        className={`${classNameVal} dark:stroke-[#F1F3F4]`}
        stroke="#384049"
      />
    )
  } else if (
    (app === Apps.Github && entity === ConnectorType.MCP) ||
    entity === SystemEntity.SystemInfo
  ) {
    return <Github size={size?.w || 12} className={classNameVal} />
  } else if (entity === SystemEntity.SystemInfo) {
    return <PlugZap size={size?.w || 12} className={classNameVal} /> // Fallback for other MCPs
  } else if (app === Apps.WebSearch && entity === WebSearchEntity.WebSearch) {
    return <Globe size={size?.w || 12} className={classNameVal} />
  } else if (
    app === Apps.DataSource &&
    entity === DataSourceEntity.DataSourceFile
  ) {
    return <FileText size={12} className={classNameVal} />
  } else {
    return <FileText size={12} className={classNameVal} /> // Generic fallback icon
  }
}

// Icon mapping from FileType to SVG component
export const getFileIcon = (file: File) => {
  const fileType = getFileType({type: file.type, name: file.name})
  
  switch (fileType) {
    case FileType.TEXT:
      return <img src={TextIcon} alt="Text file" className="w-8 h-8" />
    case FileType.IMAGE:
      return <img src={ImageIcon} alt="Image file" className="w-8 h-8" />
    case FileType.PDF:
      return <img src={PdfIcon} alt="PDF file" className="w-8 h-8" />
    case FileType.DOCUMENT:
      return <img src={DocumentIcon} alt="Document file" className="w-8 h-8" />
    case FileType.SPREADSHEET:
      return <img src={SpreadsheetIcon} alt="Spreadsheet file" className="w-8 h-8" />
    case FileType.PRESENTATION:
      return <img src={PresentationIcon} alt="Presentation file" className="w-8 h-8" />
    default:
      return <FileIcon className="w-8 h-8 text-gray-500" />
  }
}

export const minHeight = 320
export const LoaderContent = () => {
  return (
    <div
      className={`min-h-[${minHeight}px] w-full flex items-center justify-center`}
    >
      <div className="items-center justify-center">
        <LoadingSpinner className="mr-2 h-4 w-4 animate-spin" />
      </div>
    </div>
  )
}
