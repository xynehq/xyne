/* prettier-ignore-start */

/* eslint-disable */

// @ts-nocheck

// noinspection JSUnusedGlobalSymbols

// This file is auto-generated by TanStack Router

// Import Routes

import { Route as rootRoute } from './routes/__root'
import { Route as SearchImport } from './routes/search'
import { Route as AuthImport } from './routes/auth'
import { Route as IndexImport } from './routes/index'
import { Route as AdminIntegrationsImport } from './routes/admin/integrations'

// Create/Update Routes

const SearchRoute = SearchImport.update({
  path: '/search',
  getParentRoute: () => rootRoute,
} as any)

const AuthRoute = AuthImport.update({
  path: '/auth',
  getParentRoute: () => rootRoute,
} as any)

const IndexRoute = IndexImport.update({
  path: '/',
  getParentRoute: () => rootRoute,
} as any)

const AdminIntegrationsRoute = AdminIntegrationsImport.update({
  path: '/admin/integrations',
  getParentRoute: () => rootRoute,
} as any)

// Populate the FileRoutesByPath interface

declare module '@tanstack/react-router' {
  interface FileRoutesByPath {
    '/': {
      id: '/'
      path: '/'
      fullPath: '/'
      preLoaderRoute: typeof IndexImport
      parentRoute: typeof rootRoute
    }
    '/auth': {
      id: '/auth'
      path: '/auth'
      fullPath: '/auth'
      preLoaderRoute: typeof AuthImport
      parentRoute: typeof rootRoute
    }
    '/search': {
      id: '/search'
      path: '/search'
      fullPath: '/search'
      preLoaderRoute: typeof SearchImport
      parentRoute: typeof rootRoute
    }
    '/admin/integrations': {
      id: '/admin/integrations'
      path: '/admin/integrations'
      fullPath: '/admin/integrations'
      preLoaderRoute: typeof AdminIntegrationsImport
      parentRoute: typeof rootRoute
    }
  }
}

// Create and export the route tree

export const routeTree = rootRoute.addChildren({
  IndexRoute,
  AuthRoute,
  SearchRoute,
  AdminIntegrationsRoute,
})

/* prettier-ignore-end */

/* ROUTE_MANIFEST_START
{
  "routes": {
    "__root__": {
      "filePath": "__root.tsx",
      "children": [
        "/",
        "/auth",
        "/search",
        "/admin/integrations"
      ]
    },
    "/": {
      "filePath": "index.tsx"
    },
    "/auth": {
      "filePath": "auth.tsx"
    },
    "/search": {
      "filePath": "search.tsx"
    },
    "/admin/integrations": {
      "filePath": "admin/integrations.tsx"
    }
  }
}
ROUTE_MANIFEST_END */
