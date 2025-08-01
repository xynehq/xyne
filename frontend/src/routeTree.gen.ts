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
import { Route as AuthenticatedTuningImport } from './routes/_authenticated/tuning'
import { Route as AuthenticatedSearchImport } from './routes/_authenticated/search'
import { Route as AuthenticatedDashboardImport } from './routes/_authenticated/dashboard'
import { Route as AuthenticatedChatImport } from './routes/_authenticated/chat'
import { Route as AuthenticatedApiKeyImport } from './routes/_authenticated/api-key'
import { Route as AuthenticatedAgentImport } from './routes/_authenticated/agent'
import { Route as AuthenticatedIntegrationsIndexImport } from './routes/_authenticated/integrations/index'
import { Route as AuthenticatedIntegrationsSlackImport } from './routes/_authenticated/integrations/slack'
import { Route as AuthenticatedIntegrationsMcpImport } from './routes/_authenticated/integrations/mcp'
import { Route as AuthenticatedIntegrationsGoogleImport } from './routes/_authenticated/integrations/google'
import { Route as AuthenticatedIntegrationsFileuploadImport } from './routes/_authenticated/integrations/fileupload'
import { Route as AuthenticatedDataSourceDocIdImport } from './routes/_authenticated/dataSource.$docId'
import { Route as AuthenticatedChatChatIdImport } from './routes/_authenticated/chat.$chatId'
import { Route as AuthenticatedAdminIntegrationsIndexImport } from './routes/_authenticated/admin/integrations/index'
import { Route as AuthenticatedTraceChatIdMsgIdImport } from './routes/_authenticated/trace.$chatId.$msgId'
import { Route as AuthenticatedAdminIntegrationsSlackImport } from './routes/_authenticated/admin/integrations/slack'
import { Route as AuthenticatedAdminIntegrationsMcpImport } from './routes/_authenticated/admin/integrations/mcp'
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

const AuthenticatedTuningRoute = AuthenticatedTuningImport.update({
  id: '/tuning',
  path: '/tuning',
  getParentRoute: () => AuthenticatedRoute,
} as any)

const AuthenticatedSearchRoute = AuthenticatedSearchImport.update({
  id: '/search',
  path: '/search',
  getParentRoute: () => AuthenticatedRoute,
} as any)

const AuthenticatedDashboardRoute = AuthenticatedDashboardImport.update({
  id: '/dashboard',
  path: '/dashboard',
  getParentRoute: () => AuthenticatedRoute,
} as any)

const AuthenticatedChatRoute = AuthenticatedChatImport.update({
  id: '/chat',
  path: '/chat',
  getParentRoute: () => AuthenticatedRoute,
} as any)

const AuthenticatedApiKeyRoute = AuthenticatedApiKeyImport.update({
  id: '/api-key',
  path: '/api-key',
  getParentRoute: () => AuthenticatedRoute,
} as any)

const AuthenticatedAgentRoute = AuthenticatedAgentImport.update({
  id: '/agent',
  path: '/agent',
  getParentRoute: () => AuthenticatedRoute,
} as any)

const AuthenticatedIntegrationsIndexRoute =
  AuthenticatedIntegrationsIndexImport.update({
    id: '/integrations/',
    path: '/integrations/',
    getParentRoute: () => AuthenticatedRoute,
  } as any)

const AuthenticatedIntegrationsSlackRoute =
  AuthenticatedIntegrationsSlackImport.update({
    id: '/integrations/slack',
    path: '/integrations/slack',
    getParentRoute: () => AuthenticatedRoute,
  } as any)

const AuthenticatedIntegrationsMcpRoute =
  AuthenticatedIntegrationsMcpImport.update({
    id: '/integrations/mcp',
    path: '/integrations/mcp',
    getParentRoute: () => AuthenticatedRoute,
  } as any)

const AuthenticatedIntegrationsGoogleRoute =
  AuthenticatedIntegrationsGoogleImport.update({
    id: '/integrations/google',
    path: '/integrations/google',
    getParentRoute: () => AuthenticatedRoute,
  } as any)

const AuthenticatedIntegrationsFileuploadRoute =
  AuthenticatedIntegrationsFileuploadImport.update({
    id: '/integrations/fileupload',
    path: '/integrations/fileupload',
    getParentRoute: () => AuthenticatedRoute,
  } as any)

const AuthenticatedDataSourceDocIdRoute =
  AuthenticatedDataSourceDocIdImport.update({
    id: '/dataSource/$docId',
    path: '/dataSource/$docId',
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

const AuthenticatedTraceChatIdMsgIdRoute =
  AuthenticatedTraceChatIdMsgIdImport.update({
    id: '/trace/$chatId/$msgId',
    path: '/trace/$chatId/$msgId',
    getParentRoute: () => AuthenticatedRoute,
  } as any)

const AuthenticatedAdminIntegrationsSlackRoute =
  AuthenticatedAdminIntegrationsSlackImport.update({
    id: '/admin/integrations/slack',
    path: '/admin/integrations/slack',
    getParentRoute: () => AuthenticatedRoute,
  } as any)

const AuthenticatedAdminIntegrationsMcpRoute =
  AuthenticatedAdminIntegrationsMcpImport.update({
    id: '/admin/integrations/mcp',
    path: '/admin/integrations/mcp',
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
    '/_authenticated/agent': {
      id: '/_authenticated/agent'
      path: '/agent'
      fullPath: '/agent'
      preLoaderRoute: typeof AuthenticatedAgentImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/api-key': {
      id: '/_authenticated/api-key'
      path: '/api-key'
      fullPath: '/api-key'
      preLoaderRoute: typeof AuthenticatedApiKeyImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/chat': {
      id: '/_authenticated/chat'
      path: '/chat'
      fullPath: '/chat'
      preLoaderRoute: typeof AuthenticatedChatImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/dashboard': {
      id: '/_authenticated/dashboard'
      path: '/dashboard'
      fullPath: '/dashboard'
      preLoaderRoute: typeof AuthenticatedDashboardImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/search': {
      id: '/_authenticated/search'
      path: '/search'
      fullPath: '/search'
      preLoaderRoute: typeof AuthenticatedSearchImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/tuning': {
      id: '/_authenticated/tuning'
      path: '/tuning'
      fullPath: '/tuning'
      preLoaderRoute: typeof AuthenticatedTuningImport
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
    '/_authenticated/dataSource/$docId': {
      id: '/_authenticated/dataSource/$docId'
      path: '/dataSource/$docId'
      fullPath: '/dataSource/$docId'
      preLoaderRoute: typeof AuthenticatedDataSourceDocIdImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/integrations/fileupload': {
      id: '/_authenticated/integrations/fileupload'
      path: '/integrations/fileupload'
      fullPath: '/integrations/fileupload'
      preLoaderRoute: typeof AuthenticatedIntegrationsFileuploadImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/integrations/google': {
      id: '/_authenticated/integrations/google'
      path: '/integrations/google'
      fullPath: '/integrations/google'
      preLoaderRoute: typeof AuthenticatedIntegrationsGoogleImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/integrations/mcp': {
      id: '/_authenticated/integrations/mcp'
      path: '/integrations/mcp'
      fullPath: '/integrations/mcp'
      preLoaderRoute: typeof AuthenticatedIntegrationsMcpImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/integrations/slack': {
      id: '/_authenticated/integrations/slack'
      path: '/integrations/slack'
      fullPath: '/integrations/slack'
      preLoaderRoute: typeof AuthenticatedIntegrationsSlackImport
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
    '/_authenticated/admin/integrations/mcp': {
      id: '/_authenticated/admin/integrations/mcp'
      path: '/admin/integrations/mcp'
      fullPath: '/admin/integrations/mcp'
      preLoaderRoute: typeof AuthenticatedAdminIntegrationsMcpImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/admin/integrations/slack': {
      id: '/_authenticated/admin/integrations/slack'
      path: '/admin/integrations/slack'
      fullPath: '/admin/integrations/slack'
      preLoaderRoute: typeof AuthenticatedAdminIntegrationsSlackImport
      parentRoute: typeof AuthenticatedImport
    }
    '/_authenticated/trace/$chatId/$msgId': {
      id: '/_authenticated/trace/$chatId/$msgId'
      path: '/trace/$chatId/$msgId'
      fullPath: '/trace/$chatId/$msgId'
      preLoaderRoute: typeof AuthenticatedTraceChatIdMsgIdImport
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
  AuthenticatedAgentRoute: typeof AuthenticatedAgentRoute
  AuthenticatedApiKeyRoute: typeof AuthenticatedApiKeyRoute
  AuthenticatedChatRoute: typeof AuthenticatedChatRouteWithChildren
  AuthenticatedDashboardRoute: typeof AuthenticatedDashboardRoute
  AuthenticatedSearchRoute: typeof AuthenticatedSearchRoute
  AuthenticatedTuningRoute: typeof AuthenticatedTuningRoute
  AuthenticatedIndexRoute: typeof AuthenticatedIndexRoute
  AuthenticatedDataSourceDocIdRoute: typeof AuthenticatedDataSourceDocIdRoute
  AuthenticatedIntegrationsFileuploadRoute: typeof AuthenticatedIntegrationsFileuploadRoute
  AuthenticatedIntegrationsGoogleRoute: typeof AuthenticatedIntegrationsGoogleRoute
  AuthenticatedIntegrationsMcpRoute: typeof AuthenticatedIntegrationsMcpRoute
  AuthenticatedIntegrationsSlackRoute: typeof AuthenticatedIntegrationsSlackRoute
  AuthenticatedIntegrationsIndexRoute: typeof AuthenticatedIntegrationsIndexRoute
  AuthenticatedAdminIntegrationsGoogleRoute: typeof AuthenticatedAdminIntegrationsGoogleRoute
  AuthenticatedAdminIntegrationsMcpRoute: typeof AuthenticatedAdminIntegrationsMcpRoute
  AuthenticatedAdminIntegrationsSlackRoute: typeof AuthenticatedAdminIntegrationsSlackRoute
  AuthenticatedTraceChatIdMsgIdRoute: typeof AuthenticatedTraceChatIdMsgIdRoute
  AuthenticatedAdminIntegrationsIndexRoute: typeof AuthenticatedAdminIntegrationsIndexRoute
}

const AuthenticatedRouteChildren: AuthenticatedRouteChildren = {
  AuthenticatedAgentRoute: AuthenticatedAgentRoute,
  AuthenticatedApiKeyRoute: AuthenticatedApiKeyRoute,
  AuthenticatedChatRoute: AuthenticatedChatRouteWithChildren,
  AuthenticatedDashboardRoute: AuthenticatedDashboardRoute,
  AuthenticatedSearchRoute: AuthenticatedSearchRoute,
  AuthenticatedTuningRoute: AuthenticatedTuningRoute,
  AuthenticatedIndexRoute: AuthenticatedIndexRoute,
  AuthenticatedDataSourceDocIdRoute: AuthenticatedDataSourceDocIdRoute,
  AuthenticatedIntegrationsFileuploadRoute:
    AuthenticatedIntegrationsFileuploadRoute,
  AuthenticatedIntegrationsGoogleRoute: AuthenticatedIntegrationsGoogleRoute,
  AuthenticatedIntegrationsMcpRoute: AuthenticatedIntegrationsMcpRoute,
  AuthenticatedIntegrationsSlackRoute: AuthenticatedIntegrationsSlackRoute,
  AuthenticatedIntegrationsIndexRoute: AuthenticatedIntegrationsIndexRoute,
  AuthenticatedAdminIntegrationsGoogleRoute:
    AuthenticatedAdminIntegrationsGoogleRoute,
  AuthenticatedAdminIntegrationsMcpRoute:
    AuthenticatedAdminIntegrationsMcpRoute,
  AuthenticatedAdminIntegrationsSlackRoute:
    AuthenticatedAdminIntegrationsSlackRoute,
  AuthenticatedTraceChatIdMsgIdRoute: AuthenticatedTraceChatIdMsgIdRoute,
  AuthenticatedAdminIntegrationsIndexRoute:
    AuthenticatedAdminIntegrationsIndexRoute,
}

const AuthenticatedRouteWithChildren = AuthenticatedRoute._addFileChildren(
  AuthenticatedRouteChildren,
)

export interface FileRoutesByFullPath {
  '': typeof AuthenticatedRouteWithChildren
  '/auth': typeof AuthRoute
  '/agent': typeof AuthenticatedAgentRoute
  '/api-key': typeof AuthenticatedApiKeyRoute
  '/chat': typeof AuthenticatedChatRouteWithChildren
  '/dashboard': typeof AuthenticatedDashboardRoute
  '/search': typeof AuthenticatedSearchRoute
  '/tuning': typeof AuthenticatedTuningRoute
  '/oauth/success': typeof OauthSuccessRoute
  '/': typeof AuthenticatedIndexRoute
  '/chat/$chatId': typeof AuthenticatedChatChatIdRoute
  '/dataSource/$docId': typeof AuthenticatedDataSourceDocIdRoute
  '/integrations/fileupload': typeof AuthenticatedIntegrationsFileuploadRoute
  '/integrations/google': typeof AuthenticatedIntegrationsGoogleRoute
  '/integrations/mcp': typeof AuthenticatedIntegrationsMcpRoute
  '/integrations/slack': typeof AuthenticatedIntegrationsSlackRoute
  '/integrations': typeof AuthenticatedIntegrationsIndexRoute
  '/admin/integrations/google': typeof AuthenticatedAdminIntegrationsGoogleRoute
  '/admin/integrations/mcp': typeof AuthenticatedAdminIntegrationsMcpRoute
  '/admin/integrations/slack': typeof AuthenticatedAdminIntegrationsSlackRoute
  '/trace/$chatId/$msgId': typeof AuthenticatedTraceChatIdMsgIdRoute
  '/admin/integrations': typeof AuthenticatedAdminIntegrationsIndexRoute
}

export interface FileRoutesByTo {
  '/auth': typeof AuthRoute
  '/agent': typeof AuthenticatedAgentRoute
  '/api-key': typeof AuthenticatedApiKeyRoute
  '/chat': typeof AuthenticatedChatRouteWithChildren
  '/dashboard': typeof AuthenticatedDashboardRoute
  '/search': typeof AuthenticatedSearchRoute
  '/tuning': typeof AuthenticatedTuningRoute
  '/oauth/success': typeof OauthSuccessRoute
  '/': typeof AuthenticatedIndexRoute
  '/chat/$chatId': typeof AuthenticatedChatChatIdRoute
  '/dataSource/$docId': typeof AuthenticatedDataSourceDocIdRoute
  '/integrations/fileupload': typeof AuthenticatedIntegrationsFileuploadRoute
  '/integrations/google': typeof AuthenticatedIntegrationsGoogleRoute
  '/integrations/mcp': typeof AuthenticatedIntegrationsMcpRoute
  '/integrations/slack': typeof AuthenticatedIntegrationsSlackRoute
  '/integrations': typeof AuthenticatedIntegrationsIndexRoute
  '/admin/integrations/google': typeof AuthenticatedAdminIntegrationsGoogleRoute
  '/admin/integrations/mcp': typeof AuthenticatedAdminIntegrationsMcpRoute
  '/admin/integrations/slack': typeof AuthenticatedAdminIntegrationsSlackRoute
  '/trace/$chatId/$msgId': typeof AuthenticatedTraceChatIdMsgIdRoute
  '/admin/integrations': typeof AuthenticatedAdminIntegrationsIndexRoute
}

export interface FileRoutesById {
  __root__: typeof rootRoute
  '/_authenticated': typeof AuthenticatedRouteWithChildren
  '/auth': typeof AuthRoute
  '/_authenticated/agent': typeof AuthenticatedAgentRoute
  '/_authenticated/api-key': typeof AuthenticatedApiKeyRoute
  '/_authenticated/chat': typeof AuthenticatedChatRouteWithChildren
  '/_authenticated/dashboard': typeof AuthenticatedDashboardRoute
  '/_authenticated/search': typeof AuthenticatedSearchRoute
  '/_authenticated/tuning': typeof AuthenticatedTuningRoute
  '/oauth/success': typeof OauthSuccessRoute
  '/_authenticated/': typeof AuthenticatedIndexRoute
  '/_authenticated/chat/$chatId': typeof AuthenticatedChatChatIdRoute
  '/_authenticated/dataSource/$docId': typeof AuthenticatedDataSourceDocIdRoute
  '/_authenticated/integrations/fileupload': typeof AuthenticatedIntegrationsFileuploadRoute
  '/_authenticated/integrations/google': typeof AuthenticatedIntegrationsGoogleRoute
  '/_authenticated/integrations/mcp': typeof AuthenticatedIntegrationsMcpRoute
  '/_authenticated/integrations/slack': typeof AuthenticatedIntegrationsSlackRoute
  '/_authenticated/integrations/': typeof AuthenticatedIntegrationsIndexRoute
  '/_authenticated/admin/integrations/google': typeof AuthenticatedAdminIntegrationsGoogleRoute
  '/_authenticated/admin/integrations/mcp': typeof AuthenticatedAdminIntegrationsMcpRoute
  '/_authenticated/admin/integrations/slack': typeof AuthenticatedAdminIntegrationsSlackRoute
  '/_authenticated/trace/$chatId/$msgId': typeof AuthenticatedTraceChatIdMsgIdRoute
  '/_authenticated/admin/integrations/': typeof AuthenticatedAdminIntegrationsIndexRoute
}

export interface FileRouteTypes {
  fileRoutesByFullPath: FileRoutesByFullPath
  fullPaths:
    | ''
    | '/auth'
    | '/agent'
    | '/api-key'
    | '/chat'
    | '/dashboard'
    | '/search'
    | '/tuning'
    | '/oauth/success'
    | '/'
    | '/chat/$chatId'
    | '/dataSource/$docId'
    | '/integrations/fileupload'
    | '/integrations/google'
    | '/integrations/mcp'
    | '/integrations/slack'
    | '/integrations'
    | '/admin/integrations/google'
    | '/admin/integrations/mcp'
    | '/admin/integrations/slack'
    | '/trace/$chatId/$msgId'
    | '/admin/integrations'
  fileRoutesByTo: FileRoutesByTo
  to:
    | '/auth'
    | '/agent'
    | '/api-key'
    | '/chat'
    | '/dashboard'
    | '/search'
    | '/tuning'
    | '/oauth/success'
    | '/'
    | '/chat/$chatId'
    | '/dataSource/$docId'
    | '/integrations/fileupload'
    | '/integrations/google'
    | '/integrations/mcp'
    | '/integrations/slack'
    | '/integrations'
    | '/admin/integrations/google'
    | '/admin/integrations/mcp'
    | '/admin/integrations/slack'
    | '/trace/$chatId/$msgId'
    | '/admin/integrations'
  id:
    | '__root__'
    | '/_authenticated'
    | '/auth'
    | '/_authenticated/agent'
    | '/_authenticated/api-key'
    | '/_authenticated/chat'
    | '/_authenticated/dashboard'
    | '/_authenticated/search'
    | '/_authenticated/tuning'
    | '/oauth/success'
    | '/_authenticated/'
    | '/_authenticated/chat/$chatId'
    | '/_authenticated/dataSource/$docId'
    | '/_authenticated/integrations/fileupload'
    | '/_authenticated/integrations/google'
    | '/_authenticated/integrations/mcp'
    | '/_authenticated/integrations/slack'
    | '/_authenticated/integrations/'
    | '/_authenticated/admin/integrations/google'
    | '/_authenticated/admin/integrations/mcp'
    | '/_authenticated/admin/integrations/slack'
    | '/_authenticated/trace/$chatId/$msgId'
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
        "/_authenticated/agent",
        "/_authenticated/api-key",
        "/_authenticated/chat",
        "/_authenticated/dashboard",
        "/_authenticated/search",
        "/_authenticated/tuning",
        "/_authenticated/",
        "/_authenticated/dataSource/$docId",
        "/_authenticated/integrations/fileupload",
        "/_authenticated/integrations/google",
        "/_authenticated/integrations/mcp",
        "/_authenticated/integrations/slack",
        "/_authenticated/integrations/",
        "/_authenticated/admin/integrations/google",
        "/_authenticated/admin/integrations/mcp",
        "/_authenticated/admin/integrations/slack",
        "/_authenticated/trace/$chatId/$msgId",
        "/_authenticated/admin/integrations/"
      ]
    },
    "/auth": {
      "filePath": "auth.tsx"
    },
    "/_authenticated/agent": {
      "filePath": "_authenticated/agent.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/api-key": {
      "filePath": "_authenticated/api-key.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/chat": {
      "filePath": "_authenticated/chat.tsx",
      "parent": "/_authenticated",
      "children": [
        "/_authenticated/chat/$chatId"
      ]
    },
    "/_authenticated/dashboard": {
      "filePath": "_authenticated/dashboard.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/search": {
      "filePath": "_authenticated/search.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/tuning": {
      "filePath": "_authenticated/tuning.tsx",
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
    "/_authenticated/dataSource/$docId": {
      "filePath": "_authenticated/dataSource.$docId.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/integrations/fileupload": {
      "filePath": "_authenticated/integrations/fileupload.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/integrations/google": {
      "filePath": "_authenticated/integrations/google.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/integrations/mcp": {
      "filePath": "_authenticated/integrations/mcp.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/integrations/slack": {
      "filePath": "_authenticated/integrations/slack.tsx",
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
    "/_authenticated/admin/integrations/mcp": {
      "filePath": "_authenticated/admin/integrations/mcp.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/admin/integrations/slack": {
      "filePath": "_authenticated/admin/integrations/slack.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/trace/$chatId/$msgId": {
      "filePath": "_authenticated/trace.$chatId.$msgId.tsx",
      "parent": "/_authenticated"
    },
    "/_authenticated/admin/integrations/": {
      "filePath": "_authenticated/admin/integrations/index.tsx",
      "parent": "/_authenticated"
    }
  }
}
ROUTE_MANIFEST_END */
