import { Folder } from 'lucide-react';
import DocsSvg from '@/assets/docs.svg'
import SlidesSvg from '@/assets/slides.svg'
import SheetsSvg from '@/assets/sheets.svg'
import DriveSvg from '@/assets/drive.svg'
import NotionPageSvg from '../assets/notionPage.svg'
import type { Entity } from 'shared/types'
import { Apps, DriveEntity, NotionEntity } from 'shared/types';


export const getIcon = (app: Apps, entity: Entity) => {
  const classNameVal = 'h-[16px] w-[16px] mr-2'
  if (app === Apps.GoogleDrive) {
    if (entity === DriveEntity.Docs) {
      return <img className={ classNameVal } src = { DocsSvg } />
    } else if (entity === DriveEntity.Sheets) {
      return <img className={ classNameVal } src = { SheetsSvg } />
    } else if (entity === DriveEntity.Presentation) {
      return <img className={ classNameVal } src = { SlidesSvg } />
    } else if (entity === DriveEntity.Folder) {
      return <Folder className='h-[17px] w-[17px] mr-2' fill = 'rgb(196, 199, 197)' stroke = 'none' />
    } else {
      return <img className={ classNameVal } src = { DriveSvg } />
    }
  } else if (app === Apps.Notion) {
    if (entity === NotionEntity.Page) {
      return <img className={ classNameVal } src = { NotionPageSvg } />
    }
  }
}