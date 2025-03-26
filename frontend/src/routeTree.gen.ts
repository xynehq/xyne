/* eslint-disable */

// @ts-nocheck

// noinspection JSUnusedGlobalSymbols

// This file was automatically generated by TanStack Router.
// You should NOT make any changes in this file as it will be overwritten.
// Additionally, you should also exclude this file from your linter and/or formatter to prevent it from being checked or modified.

// Import Routes

import { Route as rootRoute } from './routes/__root'
import { Route as AuthImport } from './routes/auth'
import { Route as AuthenticatedImport } from './routes/_authenticated'
import { Route as AuthenticatedIndexImport } from './routes/_authenticated/index'
import { Route as OauthSuccessImport } from './routes/oauth/success'
import { Route as AuthenticatedSearchImport } from './routes/_authenticated/search'
import { Route as AuthenticatedChatImport } from './routes/_authenticated/chat'
import { Route as AuthenticatedIntegrationsIndexImport } from './routes/_authenticated/integrations/index'
import { Route as AuthenticatedIntegrationsWhatsappImport } from './routes/_authenticated/integrations/whatsapp'
import { Route as AuthenticatedIntegrationsSlackImport } from './routes/_authenticated/integrations/slack'
import { Route as AuthenticatedIntegrationsGoogleImport } from './routes/_authenticated/integrations/google'
import { Route as AuthenticatedChatChatIdImport } from './routes/_authenticated/chat.$chatId'
import { Route as AuthenticatedAdminIntegrationsIndexImport } from './routes/_authenticated/admin/integrations/index'
import { Route as AuthenticatedAdminIntegrationsWhatsappImport } from './routes/_authenticated/admin/integrations/whatsapp'
import { Route as AuthenticatedAdminIntegrationsSlackImport } from './routes/_authenticated/admin/integrations/slack'
import { Route as AuthenticatedAdminIntegrationsGoogleImport } from './routes/_authenticated/admin/integrations/google'

// Create/Update Routes

const AuthRoute = AuthImport.update({
  id: '/auth',
  path: '/auth',
  getParentRoute: () => rootRoute,
} as any)

const AuthenticatedRoute = AuthenticatedImport.update({
  id: '/_authenticated',
  getParentRoute: () => rootRoute,
} as any)

const AuthenticatedIndexRoute = AuthenticatedIndexImport.update({
  id: '/',
  path: '/',
  getParentRoute: () => AuthenticatedRoute,
} as any)

const OauthSuccessRoute = OauthSuccessImport.update({
  id: '/oauth/success',
  path: '/oauth/success',
  getParentRoute: () => rootRoute,
} as any)

const AuthenticatedSearchRoute = AuthenticatedSearchImport.update({
  id: '/search',
  path: '/search',
  getParentRoute: () => AuthenticatedRoute,
} as any)

const AuthenticatedChatRoute = AuthenticatedChatImport.update({
  id: '/chat',
  path: '/chat',
  getParentRoute: () => AuthenticatedRoute,
} as any)

const AuthenticatedIntegrationsIndexRoute =
  AuthenticatedIntegrationsIndexImport.update({
    id: '/integrations/',
    path: '/integrations/',
    getParentRoute: () => AuthenticatedRoute,
  } as any)

const AuthenticatedIntegrationsWhatsappRoute =
  AuthenticatedIntegrationsWhatsappImport.update({
    id: '/integrations/whatsapp',
    path: '/integrations/whatsapp',
    getParentRoute: () => AuthenticatedRoute,
  } as any)

const AuthenticatedIntegrationsSlackRoute =
  AuthenticatedIntegrationsSlackImport.update({
    id: '/integrations/slack',
    path: '/integrations/slack',
    getParentRoute: () => AuthenticatedRoute,
  } as any)

const AuthenticatedIntegrationsGoogleRoute =
  AuthenticatedIntegrationsGoogleImport.update({
    id: '/integrations/google',
    path: '/integrations/google',
    getParentRoute: () => AuthenticatedRoute,
  } as any)

const AuthenticatedChatChatIdRoute = AuthenticatedChatChatIdImport.update({
  id: '/$chatId',
  path: '/$chatId',
  getParentRoute: () => AuthenticatedChatRoute,
} as any)

const AuthenticatedAdminIntegrationsIndexRoute =
  AuthenticatedAdminIntegrationsIndexImport.update({
    id: '/admin/integrations/',
    path: '/admin/integrations/',
    getParentRoute: () => AuthenticatedRoute,
  } as any)

const AuthenticatedAdminIntegrationsWhatsappRoute =
  AuthenticatedAdminIntegrationsWhatsappImport.update({
    id: '/admin/integrations/whatsapp',
    path: '/admin/integrations/whatsapp',
    getParentRoute: () => AuthenticatedRoute,
  } as any)

const AuthenticatedAdminIntegrationsSlackRoute =
  AuthenticatedAdminIntegrationsSlackImport.update({
    id: '/admin/integrations/slack',
    path: '/admin/integrations/slack',
    getParentRoute: () => AuthenticatedRoute,
  } as any)

const AuthenticatedAdminIntegrationsGoogleRoute =
  AuthenticatedAdminIntegrationsGoogleImport.update({
    id: '/admin/integrations/google',
    path: '/admin/integrations/google',
    getParentRoute: () => AuthenticatedRoute,
  } as any)

// Populate the FileRoutesByPath interface

declare module '@tanstack/react-router' {
  interface FileRoutesByPath {
    '/_authenticated': {
      id: '/_authenticated'
      path: ''
      fullPath: ''
      preLoaderRoute: typeof AuthenticatedImport
      parentRoute: typeof rootRoute
    }
    '/auth': {
      id: '/auth'
      path: '/auth'
      fullPath: '/auth'
      preLoaderRoute: typeof AuthImport
      parentRoute: typeof rootRoute
    }
    '/_authenticated/chat': {
      id: '/_authenticated/chat'
      path: '/chat'
      fullPath: '/chat'
      preLoaderRoute: typeof AuthenticatedChatImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/search': {
      id: '/_authenticated/search'
      path: '/search'
      fullPath: '/search'
      preLoaderRoute: typeof AuthenticatedSearchImport
      parentRoute: typeof AuthenticatedImport
    }
    '/oauth/success': {
      id: '/oauth/success'
      path: '/oauth/success'
      fullPath: '/oauth/success'
      preLoaderRoute: typeof OauthSuccessImport
      parentRoute: typeof rootRoute
    }
    '/_authenticated/': {
      id: '/_authenticated/'
      path: '/'
      fullPath: '/'
      preLoaderRoute: typeof AuthenticatedIndexImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/chat/$chatId': {
      id: '/_authenticated/chat/$chatId'
      path: '/$chatId'
      fullPath: '/chat/$chatId'
      preLoaderRoute: typeof AuthenticatedChatChatIdImport
      parentRoute: typeof AuthenticatedChatImport
    }
    '/_authenticated/integrations/google': {
      id: '/_authenticated/integrations/google'
      path: '/integrations/google'
      fullPath: '/integrations/google'
      preLoaderRoute: typeof AuthenticatedIntegrationsGoogleImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/integrations/slack': {
      id: '/_authenticated/integrations/slack'
      path: '/integrations/slack'
      fullPath: '/integrations/slack'
      preLoaderRoute: typeof AuthenticatedIntegrationsSlackImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/integrations/whatsapp': {
      id: '/_authenticated/integrations/whatsapp'
      path: '/integrations/whatsapp'
      fullPath: '/integrations/whatsapp'
      preLoaderRoute: typeof AuthenticatedIntegrationsWhatsappImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/integrations/': {
      id: '/_authenticated/integrations/'
      path: '/integrations'
      fullPath: '/integrations'
      preLoaderRoute: typeof AuthenticatedIntegrationsIndexImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/admin/integrations/google': {
      id: '/_authenticated/admin/integrations/google'
      path: '/admin/integrations/google'
      fullPath: '/admin/integrations/google'
      preLoaderRoute: typeof AuthenticatedAdminIntegrationsGoogleImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/admin/integrations/slack': {
      id: '/_authenticated/admin/integrations/slack'
      path: '/admin/integrations/slack'
      fullPath: '/admin/integrations/slack'
      preLoaderRoute: typeof AuthenticatedAdminIntegrationsSlackImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/admin/integrations/whatsapp': {
      id: '/_authenticated/admin/integrations/whatsapp'
      path: '/admin/integrations/whatsapp'
      fullPath: '/admin/integrations/whatsapp'
      preLoaderRoute: typeof AuthenticatedAdminIntegrationsWhatsappImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/admin/integrations/': {
      id: '/_authenticated/admin/integrations/'
      path: '/admin/integrations'
      fullPath: '/admin/integrations'
      preLoaderRoute: typeof AuthenticatedAdminIntegrationsIndexImport
      parentRoute: typeof AuthenticatedImport
    }
  }
}

// Create and export the route tree

interface AuthenticatedChatRouteChildren {
  AuthenticatedChatChatIdRoute: typeof AuthenticatedChatChatIdRoute
}

const AuthenticatedChatRouteChildren: AuthenticatedChatRouteChildren = {
  AuthenticatedChatChatIdRoute: AuthenticatedChatChatIdRoute,
}

const AuthenticatedChatRouteWithChildren =
  AuthenticatedChatRoute._addFileChildren(AuthenticatedChatRouteChildren)

interface AuthenticatedRouteChildren {
  AuthenticatedChatRoute: typeof AuthenticatedChatRouteWithChildren
  AuthenticatedSearchRoute: typeof AuthenticatedSearchRoute
  AuthenticatedIndexRoute: typeof AuthenticatedIndexRoute
  AuthenticatedIntegrationsGoogleRoute: typeof AuthenticatedIntegrationsGoogleRoute
  AuthenticatedIntegrationsSlackRoute: typeof AuthenticatedIntegrationsSlackRoute
  AuthenticatedIntegrationsWhatsappRoute: typeof AuthenticatedIntegrationsWhatsappRoute
  AuthenticatedIntegrationsIndexRoute: typeof AuthenticatedIntegrationsIndexRoute
  AuthenticatedAdminIntegrationsGoogleRoute: typeof AuthenticatedAdminIntegrationsGoogleRoute
  AuthenticatedAdminIntegrationsSlackRoute: typeof AuthenticatedAdminIntegrationsSlackRoute
  AuthenticatedAdminIntegrationsWhatsappRoute: typeof AuthenticatedAdminIntegrationsWhatsappRoute
  AuthenticatedAdminIntegrationsIndexRoute: typeof AuthenticatedAdminIntegrationsIndexRoute
}

const AuthenticatedRouteChildren: AuthenticatedRouteChildren = {
  AuthenticatedChatRoute: AuthenticatedChatRouteWithChildren,
  AuthenticatedSearchRoute: AuthenticatedSearchRoute,
  AuthenticatedIndexRoute: AuthenticatedIndexRoute,
  AuthenticatedIntegrationsGoogleRoute: AuthenticatedIntegrationsGoogleRoute,
  AuthenticatedIntegrationsSlackRoute: AuthenticatedIntegrationsSlackRoute,
  AuthenticatedIntegrationsWhatsappRoute:
    AuthenticatedIntegrationsWhatsappRoute,
  AuthenticatedIntegrationsIndexRoute: AuthenticatedIntegrationsIndexRoute,
  AuthenticatedAdminIntegrationsGoogleRoute:
    AuthenticatedAdminIntegrationsGoogleRoute,
  AuthenticatedAdminIntegrationsSlackRoute:
    AuthenticatedAdminIntegrationsSlackRoute,
  AuthenticatedAdminIntegrationsWhatsappRoute:
    AuthenticatedAdminIntegrationsWhatsappRoute,
  AuthenticatedAdminIntegrationsIndexRoute:
    AuthenticatedAdminIntegrationsIndexRoute,
}

const AuthenticatedRouteWithChildren = AuthenticatedRoute._addFileChildren(
  AuthenticatedRouteChildren,
)

export interface FileRoutesByFullPath {
  '': typeof AuthenticatedRouteWithChildren
  '/auth': typeof AuthRoute
  '/chat': typeof AuthenticatedChatRouteWithChildren
  '/search': typeof AuthenticatedSearchRoute
  '/oauth/success': typeof OauthSuccessRoute
  '/': typeof AuthenticatedIndexRoute
  '/chat/$chatId': typeof AuthenticatedChatChatIdRoute
  '/integrations/google': typeof AuthenticatedIntegrationsGoogleRoute
  '/integrations/slack': typeof AuthenticatedIntegrationsSlackRoute
  '/integrations/whatsapp': typeof AuthenticatedIntegrationsWhatsappRoute
  '/integrations': typeof AuthenticatedIntegrationsIndexRoute
  '/admin/integrations/google': typeof AuthenticatedAdminIntegrationsGoogleRoute
  '/admin/integrations/slack': typeof AuthenticatedAdminIntegrationsSlackRoute
  '/admin/integrations/whatsapp': typeof AuthenticatedAdminIntegrationsWhatsappRoute
  '/admin/integrations': typeof AuthenticatedAdminIntegrationsIndexRoute
}

export interface FileRoutesByTo {
  '/auth': typeof AuthRoute
  '/chat': typeof AuthenticatedChatRouteWithChildren
  '/search': typeof AuthenticatedSearchRoute
  '/oauth/success': typeof OauthSuccessRoute
  '/': typeof AuthenticatedIndexRoute
  '/chat/$chatId': typeof AuthenticatedChatChatIdRoute
  '/integrations/google': typeof AuthenticatedIntegrationsGoogleRoute
  '/integrations/slack': typeof AuthenticatedIntegrationsSlackRoute
  '/integrations/whatsapp': typeof AuthenticatedIntegrationsWhatsappRoute
  '/integrations': typeof AuthenticatedIntegrationsIndexRoute
  '/admin/integrations/google': typeof AuthenticatedAdminIntegrationsGoogleRoute
  '/admin/integrations/slack': typeof AuthenticatedAdminIntegrationsSlackRoute
  '/admin/integrations/whatsapp': typeof AuthenticatedAdminIntegrationsWhatsappRoute
  '/admin/integrations': typeof AuthenticatedAdminIntegrationsIndexRoute
}

export interface FileRoutesById {
  __root__: typeof rootRoute
  '/_authenticated': typeof AuthenticatedRouteWithChildren
  '/auth': typeof AuthRoute
  '/_authenticated/chat': typeof AuthenticatedChatRouteWithChildren
  '/_authenticated/search': typeof AuthenticatedSearchRoute
  '/oauth/success': typeof OauthSuccessRoute
  '/_authenticated/': typeof AuthenticatedIndexRoute
  '/_authenticated/chat/$chatId': typeof AuthenticatedChatChatIdRoute
  '/_authenticated/integrations/google': typeof AuthenticatedIntegrationsGoogleRoute
  '/_authenticated/integrations/slack': typeof AuthenticatedIntegrationsSlackRoute
  '/_authenticated/integrations/whatsapp': typeof AuthenticatedIntegrationsWhatsappRoute
  '/_authenticated/integrations/': typeof AuthenticatedIntegrationsIndexRoute
  '/_authenticated/admin/integrations/google': typeof AuthenticatedAdminIntegrationsGoogleRoute
  '/_authenticated/admin/integrations/slack': typeof AuthenticatedAdminIntegrationsSlackRoute
  '/_authenticated/admin/integrations/whatsapp': typeof AuthenticatedAdminIntegrationsWhatsappRoute
  '/_authenticated/admin/integrations/': typeof AuthenticatedAdminIntegrationsIndexRoute
}

export interface FileRouteTypes {
  fileRoutesByFullPath: FileRoutesByFullPath
  fullPaths:
    | ''
    | '/auth'
    | '/chat'
    | '/search'
    | '/oauth/success'
    | '/'
    | '/chat/$chatId'
    | '/integrations/google'
    | '/integrations/slack'
    | '/integrations/whatsapp'
    | '/integrations'
    | '/admin/integrations/google'
    | '/admin/integrations/slack'
    | '/admin/integrations/whatsapp'
    | '/admin/integrations'
  fileRoutesByTo: FileRoutesByTo
  to:
    | '/auth'
    | '/chat'
    | '/search'
    | '/oauth/success'
    | '/'
    | '/chat/$chatId'
    | '/integrations/google'
    | '/integrations/slack'
    | '/integrations/whatsapp'
    | '/integrations'
    | '/admin/integrations/google'
    | '/admin/integrations/slack'
    | '/admin/integrations/whatsapp'
    | '/admin/integrations'
  id:
    | '__root__'
    | '/_authenticated'
    | '/auth'
    | '/_authenticated/chat'
    | '/_authenticated/search'
    | '/oauth/success'
    | '/_authenticated/'
    | '/_authenticated/chat/$chatId'
    | '/_authenticated/integrations/google'
    | '/_authenticated/integrations/slack'
    | '/_authenticated/integrations/whatsapp'
    | '/_authenticated/integrations/'
    | '/_authenticated/admin/integrations/google'
    | '/_authenticated/admin/integrations/slack'
    | '/_authenticated/admin/integrations/whatsapp'
    | '/_authenticated/admin/integrations/'
  fileRoutesById: FileRoutesById
}

export interface RootRouteChildren {
  AuthenticatedRoute: typeof AuthenticatedRouteWithChildren
  AuthRoute: typeof AuthRoute
  OauthSuccessRoute: typeof OauthSuccessRoute
}

const rootRouteChildren: RootRouteChildren = {
  AuthenticatedRoute: AuthenticatedRouteWithChildren,
  AuthRoute: AuthRoute,
  OauthSuccessRoute: OauthSuccessRoute,
}

export const routeTree = rootRoute
  ._addFileChildren(rootRouteChildren)
  ._addFileTypes<FileRouteTypes>()

/* ROUTE_MANIFEST_START
{
  "routes": {
    "__root__": {
      "filePath": "__root.tsx",
      "children": [
        "/_authenticated",
        "/auth",
        "/oauth/success"
      ]
    },
    "/_authenticated": {
      "filePath": "_authenticated.tsx",
      "children": [
        "/_authenticated/chat",
        "/_authenticated/search",
        "/_authenticated/",
        "/_authenticated/integrations/google",
        "/_authenticated/integrations/slack",
        "/_authenticated/integrations/whatsapp",
        "/_authenticated/integrations/",
        "/_authenticated/admin/integrations/google",
        "/_authenticated/admin/integrations/slack",
        "/_authenticated/admin/integrations/whatsapp",
        "/_authenticated/admin/integrations/"
      ]
    },
    "/auth": {
      "filePath": "auth.tsx"
    },
    "/_authenticated/chat": {
      "filePath": "_authenticated/chat.tsx",
      "parent": "/_authenticated",
      "children": [
        "/_authenticated/chat/$chatId"
      ]
    },
    "/_authenticated/search": {
      "filePath": "_authenticated/search.tsx",
      "parent": "/_authenticated"
    },
    "/oauth/success": {
      "filePath": "oauth/success.tsx"
    },
    "/_authenticated/": {
      "filePath": "_authenticated/index.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/chat/$chatId": {
      "filePath": "_authenticated/chat.$chatId.tsx",
      "parent": "/_authenticated/chat"
    },
    "/_authenticated/integrations/google": {
      "filePath": "_authenticated/integrations/google.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/integrations/slack": {
      "filePath": "_authenticated/integrations/slack.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/integrations/whatsapp": {
      "filePath": "_authenticated/integrations/whatsapp.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/integrations/": {
      "filePath": "_authenticated/integrations/index.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/admin/integrations/google": {
      "filePath": "_authenticated/admin/integrations/google.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/admin/integrations/slack": {
      "filePath": "_authenticated/admin/integrations/slack.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/admin/integrations/whatsapp": {
      "filePath": "_authenticated/admin/integrations/whatsapp.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/admin/integrations/": {
      "filePath": "_authenticated/admin/integrations/index.tsx",
      "parent": "/_authenticated"
    }
  }
}
ROUTE_MANIFEST_END */
