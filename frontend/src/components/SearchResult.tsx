import HighlightedText from "@/components/Highlight"
import { getIcon } from "@/lib/common"
import { SearchResultDiscriminatedUnion } from "@/server/shared/types"

export const SearchResult = ({result, index}: {result: SearchResultDiscriminatedUnion, index: number}) => {
    let content
    if(result.type === 'file') {
        content = (
        <div className='flex flex-col mt-2' key={index}>
        <div className="flex items-center justify-start space-x-2">
            <a
            href={result.url??""}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-blue-800 space-x-2"
        >
            {getIcon(result.app, result.entity)}
            {result.title}
        </a>
        </div>
        <div className='flex flex-row items-center mt-1'>
            <img  referrerPolicy="no-referrer" className='mr-2 w-[16px] h-[16px] rounded-full' src={result.photoLink ?? ""}></img>
            <a target='_blank' rel="noopener noreferrer" href={`https://contacts.google.com/${result.ownerEmail}`}>
            <p className='text-left text-sm pt-1 text-gray-500'>{result.owner}</p>
            </a>
        </div>
        {result.chunks_summary && result.chunks_summary?.length && (
            result.chunks_summary.slice(0, 2).map(summary => ((<HighlightedText chunk_summary={summary} />)))
        )}
        </div>
        )

    } else {
        // user
        content = (
        <div className='flex flex-col mt-2' key={index}>
        <div className="flex items-center justify-start space-x-2">
            <a
            href={`https://contacts.google.com/${result.email}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-blue-800 space-x-2"
        >
            {/* TODO: if photoLink doesn't exist then show icon */}
            <img  referrerPolicy="no-referrer" className='mr-2 w-[16px] h-[16px] rounded-full' src={result.photoLink}></img>
            {result.name}
        </a>
        </div>
        </div>
        )

    }
    return content
}