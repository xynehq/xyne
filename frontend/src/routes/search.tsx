import { searchSchema } from '@/types';
import { createFileRoute } from '@tanstack/react-router'
import { useSearch } from '@tanstack/react-router';
import { Index } from './index';


export const Route = createFileRoute('/search')({

  validateSearch: (search) => {
    // Parse and validate the search params using searchSchema
    return searchSchema.parse(search);
  },
  component: Index
})