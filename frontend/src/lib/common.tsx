import { Folder, Users } from "lucide-react"
import DocsSvg from "@/assets/docs.svg"
import SlidesSvg from "@/assets/slides.svg"
import SheetsSvg from "@/assets/sheets.svg"
import DriveSvg from "@/assets/drive.svg"
import NotionPageSvg from "@/assets/notionPage.svg"
import Gmail from "@/assets/gmail.svg"
import Docx from "@/assets/docx.svg"
import Pdf from "@/assets/pdf.svg"
import Slides from "@/assets/slides.svg"
import Image from "@/assets/images.svg"
import type { Entity } from "shared/types"
import {
  Apps,
  DriveEntity,
  GooglePeopleEntity,
  NotionEntity,
} from "shared/types"

export const getIcon = (
  app: Apps,
  entity: Entity,
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
    if (entity === DriveEntity.Docs) {
      return <img className={classNameVal} src={DocsSvg} />
    } else if (entity === DriveEntity.Sheets) {
      return <img className={classNameVal} src={SheetsSvg} />
    } else if (entity === DriveEntity.Presentation) {
      return <img className={classNameVal} src={SlidesSvg} />
    } else if (entity === DriveEntity.Folder) {
      return (
        <Folder
          className="h-[17px] w-[17px] mr-2"
          fill="rgb(196, 199, 197)"
          stroke="none"
        />
      )
    } else if (
      entity === GooglePeopleEntity.Contacts ||
      entity === GooglePeopleEntity.OtherContacts
    ) {
      return <Users stroke="#464B53" size={12} className="mr-[10px]" />
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
    return <img className={classNameVal} src={Gmail} />
  } else if (app === Apps.Notion) {
    if (entity === NotionEntity.Page) {
      return <img className={classNameVal} src={NotionPageSvg} />
    }
  } else {
    throw new Error(`Invalid app ${app} and entity ${entity}`)
  }
}
