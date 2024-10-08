import { getIcon } from "@/lib/common"


import type { Autocomplete } from '../../../shared/types'
import { ForwardedRef, forwardRef } from "react"



export const AutocompleteElement = forwardRef(
  (
    { result, onClick}: { result: Autocomplete, onClick: any }, ref: ForwardedRef<HTMLDivElement>
  ) => {
  return (
    <div  ref={ref} onClick={onClick} className='cursor-pointer hover:bg-gray-100 px-4 py-2'>
      <div className='flex'>
        {getIcon(result.app, result.entity)}
        <p>
          {result.title}
        </p>
      </div>
    </div>
  )
})
