import {
  Apps,
  CalendarEntity,
  DataSourceEntity,
  DriveEntity,
  Entity,
  GooglePeopleEntity,
  isMailAttachment,
  KnowledgeBaseEntity,
  SlackEntity,
  SystemEntity,
  WebSearchEntity,
} from "shared/types"
import { Filter, Groups } from "@/types"
import { getIcon } from "@/lib/common"
import allFilter from "@/assets/allFilter.svg"
import { humanizeNumbers } from "@/lib/utils"

const flattenGroups = (groups: Groups) => {
  return Object.keys(groups || {}).flatMap((app) =>
    Object.keys(groups[app as Apps] || {}).map((entity) => ({
      app: app as Apps,
      entity: entity as Entity,
      count: groups[app as Apps][entity as Entity],
    })),
  )
}

const GroupFilterItem = ({
  title,
  onClick,
  total,
  filter,
  isFilter,
  Image,
  className,
  index,
}: {
  title: string
  onClick: any
  total: number
  filter: Filter
  isFilter: (filter: Filter) => boolean
  Image: JSX.Element
  className?: string
  index: number
}) => {
  return (
    <div className={`rounded-md h-[32px] ml-[40px] ${className}`} key={index}>
      <div
        onClick={onClick}
        className={`${
          isFilter(filter) ? "bg-[#F0F4F7] dark:bg-slate-700" : ""
        } flex flex-row rounded-[6px] items-center justify-between cursor-pointer  pl-[12px] pr-[12px] pt-[4px] pb-[4px] w-[248px]`}
      >
        <div className="flex items-center">
          {Image}
          <p className="text-[#5D6878] dark:text-slate-300 text-[13px] font-medium">
            {title}
          </p>
        </div>
        {<p className="text-[#97A6C4] dark:text-slate-400 ml-7">{total}</p>}
      </div>
    </div>
  )
}

export const getName = (app: Apps, entity: Entity): string => {
  if (app === Apps.Gmail) {
    if (isMailAttachment(entity)) {
      return "Attachments"
    }
    return "Gmail"
  } else if (app === Apps.GoogleDrive) {
    if (entity === DriveEntity.PDF) {
      return "Pdf"
    } else if (entity === DriveEntity.Folder) {
      return "Folder"
    } else if (entity === DriveEntity.Sheets) {
      return "Sheets"
    } else if (entity === DriveEntity.Slides) {
      return "Slides"
    } else if (entity === DriveEntity.Docs) {
      return "Docs"
    } else if (entity === DriveEntity.Image) {
      return "Images"
    } else if (entity === DriveEntity.WordDocument) {
      return "Docx"
    } else if (entity === DriveEntity.Presentation) {
      return "Slides"
    } else if (entity === GooglePeopleEntity.Contacts) {
      return "Contacts"
    } else if (entity === GooglePeopleEntity.OtherContacts) {
      return "OtherContacts"
    } else {
      return "Drive"
    }
  } else if (app === Apps.MicrosoftDrive) {
    if (entity === DriveEntity.PDF) {
      return "Pdf"
    } else if (entity === DriveEntity.Folder) {
      return "Folder"
    } else if (entity === DriveEntity.Sheets) {
      return "Sheets"
    } else if (entity === DriveEntity.Slides) {
      return "Slides"
    } else if (entity === DriveEntity.Docs) {
      return "Docs"
    } else if (entity === DriveEntity.Image) {
      return "Images"
    } else if (entity === DriveEntity.WordDocument) {
      return "Docx"
    } else if (entity === DriveEntity.Presentation) {
      return "Slides"
    } else if (entity === GooglePeopleEntity.Contacts) {
      return "Contacts"
    } else if (entity === GooglePeopleEntity.OtherContacts) {
      return "OtherContacts"
    } else {
      return "OneDrive"
    }
  } else if (app == Apps.GoogleWorkspace) {
    return "People"
  } else if (
    app == Apps.GoogleCalendar ||
    (app == Apps.MicrosoftCalendar && entity === CalendarEntity.Event)
  ) {
    return "Event"
  } else if (app === Apps.Slack && entity === SlackEntity.Message) {
    return "Slack Message"
  } else if (app === Apps.Slack && entity === SlackEntity.User) {
    return "Slack User"
  } else if (app === Apps.Slack && entity === SlackEntity.Channel) {
    return "Slack Channel"
  } else if (app === Apps.Github && entity === SystemEntity.SystemInfo) {
    return "Github"
  } else if (
    app === Apps.DataSource &&
    entity === DataSourceEntity.DataSourceFile
  ) {
    return "Data-Source"
  } else if (app === Apps.KnowledgeBase) {
    // Handle all KnowledgeBase entities with fallback for string values
    if (entity === SystemEntity.SystemInfo) {
      return "Knowledge-Base"
    } else if (entity === KnowledgeBaseEntity.File || entity === "file") {
      return "KB Files"
    } else if (entity === KnowledgeBaseEntity.Folder || entity === "folder") {
      return "KB Folders"
    } else {
      // Fallback for any unhandled KnowledgeBase entity
      return "Knowledge-Base"
    }
  } else if (app === Apps.WebSearch && entity === WebSearchEntity.WebSearch) {
    return "Web Search"
  } else if (app === Apps.MicrosoftOutlook) {
    if (isMailAttachment(entity)) {
      return "OutLook-Attachments"
    }
    return "Outlook"
  } else {
    throw new Error(`Invalid app ${app} and entity ${entity}`)
  }
}

export const GroupFilter = ({
  groups,
  handleFilterChange,
  filter,
  total,
}: {
  groups: Groups
  handleFilterChange: any
  filter: Filter
  total: number
}) => {
  return (
    <div className="flex flex-col">
      <p className="text-[11.5px] font-medium text-[#97A6C4] dark:text-slate-400 ml-[40px] mt-[28px] tracking-[0.08em]">{`FOUND ${humanizeNumbers(total)} RESULTS`}</p>
      <GroupFilterItem
        className={"mt-4"}
        title={"All"}
        filter={filter}
        isFilter={(filter: Filter) => !filter.app && !filter.entity}
        onClick={() => {
          handleFilterChange({})
        }}
        total={total}
        Image={<img src={allFilter} className="mr-[10px]" />}
        index={0}
      />
      {flattenGroups(groups).map(({ app, entity, count }, index) => {
        return (
          <GroupFilterItem
            key={`${app}-${entity}`}
            index={index}
            title={getName(app, entity)}
            filter={filter}
            isFilter={(filter: Filter) =>
              filter.app === app && filter.entity === entity
            }
            onClick={() => {
              handleFilterChange({ app, entity })
            }}
            total={groups[app][entity]}
            Image={getIcon(app, entity)!}
          />
        )
      })}
    </div>
  )
}
