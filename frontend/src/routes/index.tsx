import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  component: Index,
})

const page = 7

import { Folder, ChevronRight, ChevronLeft } from 'lucide-react';

import { useEffect, useState } from 'react'
import DocsSvg from '../assets/docs.svg'
import SlidesSvg from '../assets/slides.svg'
import SheetsSvg from '../assets/sheets.svg'
import DriveSvg from '../assets/drive.svg'
import FolderSvg from '../assets/folder.svg'
import NotionPageSvg from '../assets/notionPage.svg'


import { Input } from '../components/ui/input'
import { Button } from '../components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/tooltip";

export function SearchInfo({info}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" className='p-0 m-0 rounded-full h-[20px] w-[20px] text-xs text-gray-500'>i</Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{info}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

const getIcon = (app: string, entity: string) => {
    const classNameVal = 'h-[16px] w-[16px] mr-2'
  if(app === 'google') {
    if(entity === 'docs') {
      return <img className={classNameVal} src={DocsSvg}/>
    } else if(entity === 'sheets') {
      return <img className={classNameVal} src={SheetsSvg}/>
    } else if(entity === 'slides') {
      return <img className={classNameVal} src={SlidesSvg}/>
    } else if(entity === 'folder') {
      return <Folder className='h-[17px] w-[17px] mr-2' fill='rgb(196, 199, 197)' stroke='none' />
    } else {
      return <img className={classNameVal} src={DriveSvg}/>
    }
  } else if(app === 'notion') {
    if(entity === 'page') {
      return <img className={classNameVal} src={NotionPageSvg} />
    }
  }
}


const flattenGroups = (groups) => {
  return Object.keys(groups || {}).flatMap((app) => 
  Object.keys(groups[app] || {}).map((entity) => ({
    app,
    entity,
    count: groups[app][entity]
  }))
);
}

function Index() {
  const [query, setQuery] = useState(''); // State to hold the search query
  const [offset, setOffset] = useState(0)
  const [results, setResults] = useState([]); // State to hold the search results
  const [groups, setGroups] = useState(null)
  const [filter, setFilter] = useState(null)

  const handleSearch = async (newOffset = offset, newFilter = filter) => {
    if (!query) return; // If the query is empty, do nothing
    // setGroups(null)

    try {
      let params;
      let groupCount;
      if(newFilter) {
        groupCount = 0
        params = new URLSearchParams({
          page: page > groups[newFilter.app][newFilter.entity] ? groups[newFilter.app][newFilter.entity] : page,
          offset: newOffset,
          query: encodeURIComponent(query),
          groupCount,
          app: newFilter.app,
          entity: newFilter.entity
        });
      } else {
        groupCount = 1
        params = new URLSearchParams({
          page: page,
          offset: newOffset,
          query: encodeURIComponent(query),
          groupCount,
        });
      }

      // Send a GET request to the backend with the search query
      const response = await fetch(`/api/search?${params?.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to fetch search results');
      }

      const data = await response.json();
      if(groupCount) {
        setGroups(data.groupCount)
      }
      setResults(data?.objects); // Update the results state with the response data
    } catch (error) {
      console.error('Error fetching search results:', error);
      setResults([]); // Clear results on error
    }
  };


  const handleNext = () => {
    const newOffset = offset + page;
    setOffset(newOffset);
    handleSearch(newOffset); // Trigger search with the updated offset
  };

  const handlePrev = () => {
    const newOffset = Math.max(0, offset - page);
    setOffset(newOffset);
    handleSearch(newOffset); // Trigger search with the updated offset
  };

  const handleFilterChange = ({app, entity}) => {
    if(filter && filter.app === app && filter.entity === entity) {
      setFilter(null)
      setOffset(0)
      handleSearch(0, null)
    } else {
      setFilter({app, entity})
      setOffset(0)
      handleSearch(0, {app, entity})
    }
  }

  return (
    <div className="p-4 flex flex-col h-full w-full">
      <div className="flex space-x-2 max-w-4xl">
        <Input
          placeholder="Search workspace"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOffset(0)
          }}
          className="px-4 py-2 border border-gray-300 rounded-md focus-visible:ring-offset-0 focus-visible:ring-0"
          onKeyDown={(e) => {
            if(e.key === 'Enter') {
              handleSearch()
            }
          }}
        />
        <Button 
          onClick={(e) => handleSearch()} 
          className="px-4 py-2 text-white rounded-md"
        >
          Search
        </Button>
      </div>
      <div className='flex flex-row'>
      <div className="mt-4 w-full pr-10 space-y-3">
        {results.length > 0 ? (
          results.map((result, index) => (
            <div className='flex flex-col mt-2' key={index}>
            <div className="flex items-center justify-start space-x-2">
              <a 
              href={result.properties.url} 
              target="_blank" 
              rel="noopener noreferrer"
              className="flex items-center text-blue-800 space-x-2"
            >
              {getIcon(result.properties.app, result.properties.entity)}
              {result.properties.title}
            </a> 
            </div>
            <div className='flex flex-row items-center mt-1'>
              <img  referrerPolicy="no-referrer" className='mr-2 w-[16px] h-[16px] rounded-full' src={result.properties.photoLink}></img>
              <a target='_blank' rel="noopener noreferrer" href={`https://contacts.google.com/${result.properties.ownerEmail}`}>
              <p className='text-left text-sm pt-1 text-gray-500'>{result.properties.owner}</p>
              </a>
            </div>
            <p className='text-left text-sm mt-1 line-clamp-[2.5] text-ellipsis overflow-hidden ...'>{result.properties.chunk ? result.properties.chunk : '...'}</p>
            </div>
          ))
        ) : (
          <p></p>
        )}
      </div>
      {
        groups && 
      (<div className='bg-slate-100 rounded-md mt-4 mr-20 max-h-fit h-fit border border-gray-100'>

            <div onClick={(e) => {
              handleFilterChange(null)
            }} className={`${filter == null ? 'bg-white' : ''} flex flex-row items-center justify-between cursor-pointer hover:bg-white p-3 pr-5`}>
              <div className="flex items-center">
          <p>All</p>
        </div>
        </div>
        {
        flattenGroups(groups).map(({app, entity, count}, index) => {
          return (
            <div key={index} onClick={(e) => {
              handleFilterChange({app, entity})
            }} className={`${filter && filter.app === app && filter.entity === entity ? 'bg-white' : ''} flex flex-row items-center justify-between cursor-pointer hover:bg-white p-3 pr-5`}>
              <div className="flex items-center">
          {getIcon(app, entity)}
          <p>{app} {entity}</p>
        </div>

             {/* {getIcon('google', group)}
              <p>{group}</p> */}
              <p className='text-blue-500 ml-7'>{groups[app][entity]}</p>
            </div>
          )
        })}
      </div>)
      }

      </div>
      <div className='mt-auto flex space-x-2 items-center justify-center w-full'>
        {offset > 0 && 
<Button className='bg-transparent border border-gray-100 text-black hover:bg-gray-100 shadow-none' onClick={(e) => {
        handlePrev()
      }}><ChevronLeft /></Button>
        }
      {results.length > 0 && results.length === page && <Button className='bg-transparent border border-gray-100 text-black hover:bg-gray-100 shadow-none' onClick={(e) => {
        handleNext()
      }}><ChevronRight /></Button>}

      </div>
    </div>
  )
}