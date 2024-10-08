import { Button } from '@/components/ui/button';
import { createFileRoute, useNavigate, UseNavigateResult } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Apps, AuthType, ConnectorStatus } from '@shared/types';
import { api, wsClient } from '@/api';
import { toast, useToast } from "@/hooks/use-toast"
import { useForm } from '@tanstack/react-form';


import { cn, getErrorMessage } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { Connectors } from '@/types';
import { OAuthModal } from '@/oauth';

const submitServiceAccountForm = async (value: ServiceAccountFormData, navigate: UseNavigateResult<string>) => {
    const response = await api.api.admin.service_account.$post({
      form: {
        'service-key': value.file,
        'app': Apps.GoogleDrive,
        'email': value.email,  // Pass email along with the file
      }
    });
    if(!response.ok) {
        // If unauthorized or status code is 401, navigate to '/auth'
        if (response.status === 401) {
          navigate({ to: '/auth' })
          throw new Error('Unauthorized')
        }
        const errorText = await response.text();
        throw new Error(`Failed to upload file: ${response.status} ${response.statusText} - ${errorText}`);
    }
    return response.json()
}

const submitOAuthForm = async (value: OAuthFormData, navigate: UseNavigateResult<string>) => {
    const response = await api.api.admin.oauth.create.$post({
      form: {
        'clientId': value.clientId,
        'clientSecret': value.clientSecret,
        'scopes': value.scopes,
        'app': Apps.GoogleDrive
      }
    });
    if(!response.ok) {
        // If unauthorized or status code is 401, navigate to '/auth'
        if (response.status === 401) {
          navigate({ to: '/auth' })
          throw new Error('Unauthorized')
        }
        const errorText = await response.text();
        throw new Error(`Failed to upload file: ${response.status} ${response.statusText} - ${errorText}`);
    }
    return response.json()
}

type ServiceAccountFormData = {
  email: string,
  file: any
}

type OAuthFormData = {
  clientId: string,
  clientSecret: string,
  scopes: string[]
}


export const OAuthForm = ({onSuccess}: {onSuccess:any}) => {

  const { toast } = useToast();
  const navigate = useNavigate();
  const form = useForm<OAuthFormData>({
    defaultValues: {
      clientId: '',
      clientSecret: '',
      scopes: []
    },
    onSubmit: async ({ value }) => {
      try {
        await submitOAuthForm(value, navigate);  // Call the async function
        toast({
          title: "OAuth integration added",
          description: "Perform OAuth to add the data",
        });
        onSuccess()
      } catch (error) {
        toast({
          title: "Could not create integration",
          description: `Error: ${getErrorMessage(error)}`,
          variant: 'destructive',
        });
      }
    },
  });
  return (
    <form
    onSubmit={(e) => {
      e.preventDefault();
      form.handleSubmit();
    }}
    className="grid w-full max-w-sm items-center gap-1.5"
  >
    <Label htmlFor="clientId">client id</Label>
    <form.Field
      name="clientId"
      validators={{
        onChange: ({ value }) => (!value ? "Client ID is required" : undefined),
      }}
      children={(field) => (
        <>
          <Input
            id="clientId"
            type="text"
            value={field.state.value}
            onChange={(e) => field.handleChange(e.target.value)}
            placeholder="Enter client id"
          />
          {field.state.meta.isTouched && field.state.meta.errors.length ? (
            <p className="text-red-600 text-sm">{field.state.meta.errors.join(", ")}</p>
          ) : null}
        </>
      )}
    />
    <Label htmlFor="clientSecret">client secret</Label>
    <form.Field
      name="clientSecret"
      validators={{
        onChange: ({ value }) => (!value ? "Client Secret is required" : undefined),
      }}
      children={(field) => (
        <>
          <Input
            id="clientSecret"
            type="password"
            value={field.state.value}
            onChange={(e) => field.handleChange(e.target.value)}
            placeholder="Enter client secret"
          />
          {field.state.meta.isTouched && field.state.meta.errors.length ? (
            <p className="text-red-600 text-sm">{field.state.meta.errors.join(", ")}</p>
          ) : null}
        </>
      )}
    />
    <Label htmlFor="scopes">scopes</Label>
    <form.Field
      name="scopes"
      validators={{
        onChange: ({ value }) => (!value ? "scopes are required" : undefined),
      }}
      children={(field) => (
        <>
          <Input
            id="scopes"
            type="text"
            value={field.state.value}
            onChange={(e) => field.handleChange(e.target.value.split(','))}
            placeholder="Enter OAuth scopes"
          />
          {field.state.meta.isTouched && field.state.meta.errors.length ? (
            <p className="text-red-600 text-sm">{field.state.meta.errors.join(", ")}</p>
          ) : null}
        </>
      )}
    />

    <Button type="submit">Create Integration</Button>
    </form>
  )
}

export const ServiceAccountForm = ({onSuccess}: {onSuccess:any}) => {
  //@ts-ignore
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const { toast } = useToast();
  const navigate = useNavigate();

  const form = useForm<ServiceAccountFormData>({
    defaultValues: {
      email: '',
      file: null
    },
    onSubmit: async ({ value }) => {
      if (!value.file) {
        toast({
          title: "No file selected",
          description: "Please upload a file before submitting.",
          variant: 'destructive',
        });
        return;
      }
    
      try {
        await submitServiceAccountForm(value, navigate);  // Call the async function
        toast({
          title: "File uploaded successfully",
          description: "Integration in progress",
        });
        onSuccess()
      } catch (error) {
        toast({
          title: "Could not upload the service account key",
          description: `Error: ${getErrorMessage(error)}`,
          variant: 'destructive',
        });
      }
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        form.handleSubmit();
      }}
      className="grid w-full max-w-sm items-center gap-1.5"
    >
       <Label htmlFor="email">Email</Label>
      <form.Field
        name="email"
        validators={{
          onChange: ({ value }) => (!value ? "Email is required" : undefined),
        }}
        children={(field) => (
          <>
            <Input
              id="email"
              type="email"
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Enter your email"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length ? (
              <p className="text-red-600 text-sm">{field.state.meta.errors.join(", ")}</p>
            ) : null}
          </>
        )}
      />

      <Label htmlFor="service-key">Google Service Account Key</Label>
      <form.Field
        name="file"
        validators={{
          onChange: ({ value }) => (!value ? "File is required" : undefined),
        }}
        children={(field) => (
          <>
            <Input
              id="service-key"
              type="file"
              onChange={(e) => field.handleChange(e.target.files?.[0])}
              className="file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
            />
            {field.state.meta.isTouched && field.state.meta.errors.length ? (
              <p className="text-red-600 text-sm">{field.state.meta.errors.join(", ")}</p>
            ) : null}
          </>
        )}
      />

      <Button type="submit">Upload</Button>
    </form>
  );
}

const OAuthButton = ({app, text, setOAuthIntegrationStatus}: {app: Apps, text: string, setOAuthIntegrationStatus: any}) => {
  const handleOAuth = async () => {
    const oauth = new OAuthModal()
    try {
      await oauth.startAuth(app)
      setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnecting)
    } catch(error) {
      toast({
        title: "Could not finish oauth",
        description: `Error: ${getErrorMessage(error)}`,
        variant: 'destructive',
      });
    }

  }

  return (
    <Button onClick={handleOAuth}>
      {text}
    </Button>
  )
}

export const LoadingSpinner = ({className}: {className: string}) => {
  return (<svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("animate-spin", className)}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>)
}
const minHeight = 320

const getConnectors = async ():Promise<any> => {
  const res = await api.api.admin.connectors.all.$get()
  if(!res.ok) {
    if(res.status === 401) {
      throw new Error('Unauthorized')
    }
    throw new Error('Could not get connectors')
  }
  return res.json()
}

const ServiceAccountTab = ({connectors, updateStatus, onSuccess, isIntegrating}: {connectors: Connectors[], updateStatus: string, onSuccess: any, isIntegrating: boolean}) => {
  const googleSAConnector = connectors.find(v => v.app === Apps.GoogleDrive && v.authType === AuthType.ServiceAccount)
  if(!isIntegrating && !googleSAConnector) {
        return (<Card>
          <CardHeader>
            <CardTitle>File Upload</CardTitle>
            <CardDescription>Upload your Google Service Account Key here.</CardDescription>
          </CardHeader>
          <CardContent>
            <ServiceAccountForm onSuccess={onSuccess} />
          </CardContent>
        </Card>)
  } else if(googleSAConnector) {
    return (<CardHeader>
      <CardTitle>{googleSAConnector?.app}</CardTitle>
      <CardDescription>Connecting App</CardDescription>
      <CardContent className='pt-0'>
        <p>updates: {updateStatus}</p>
        <p>status: {googleSAConnector?.status}</p>
      </CardContent>
    </CardHeader>)
  }
}

const LoaderContent = () => {
return (
          <div className={`min-h-[${minHeight}px] w-full flex items-center justify-center`}>
            <div className='items-center justify-center'>
              <LoadingSpinner className="mr-2 h-4 w-4 animate-spin" />
            </div>
          </div>
        )
}

enum OAuthIntegrationStatus {
  Provider = "Provider", // yet to create provider
  OAuth = "OAuth", // provider created but OAuth not yet connected
  OAuthConnecting = "OAuthConnecting",
  OAuthConnected = "OAuthConnected"
}

const AdminLayout = () => {
  const navigator = useNavigate()
  const {isPending, error, data } = useQuery<any[]>({ queryKey: ['all-connectors'], queryFn: async (): Promise<any> => {
    try {
      return await getConnectors()
    } catch(error) {
      const message = getErrorMessage(error)
      if(message === 'Unauthorized') {
        navigator({to: '/auth'})
        return []
      }
      throw error
    }
  }})
  // const [ws, setWs] = useState(null);
  const [updateStatus, setUpateStatus] = useState('')
  const [isIntegratingSA, setIsIntegratingSA] = useState<boolean>(data? !!data.find(v => v.app === Apps.GoogleDrive && v.authType === AuthType.ServiceAccount) : false)
  const [oauthIntegrationStatus, setOAuthIntegrationStatus] = useState<OAuthIntegrationStatus>(data?
    !!data.find(v => v.app === Apps.GoogleDrive && v.authType === AuthType.OAuth)  ? OAuthIntegrationStatus.OAuth : OAuthIntegrationStatus.Provider
    : OAuthIntegrationStatus.Provider)

  useEffect(() => {
    if (!isPending && data && data.length > 0) {
      setIsIntegratingSA(!!data.find(v => v.app === Apps.GoogleDrive && v.authType === AuthType.ServiceAccount))
      const connector = data.find(v => v.app === Apps.GoogleDrive && v.authType === AuthType.OAuth)
      console.log(connector)
      if(connector?.status === ConnectorStatus.Connecting) {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnecting)
      } else if(connector?.status === ConnectorStatus.Connected) {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuthConnected)
      } else if(connector?.status === ConnectorStatus.NotConnected) {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuth)
      } else {
        setOAuthIntegrationStatus(OAuthIntegrationStatus.Provider)
      }
      // setIsIntegratingProvider(!!data.find(v => v.app === Apps.GoogleDrive && v.authType === AuthType.OAuth))
    } else {
      setIsIntegratingSA(false)
      // setIsIntegratingProvider(false)
      setOAuthIntegrationStatus(OAuthIntegrationStatus.Provider)
    }
  }, [data, isPending]);

  useEffect(() => {
    let socket: WebSocket | null = null
    if(!isPending && data && data.length > 0) {
      socket = wsClient.ws.$ws({
      query: {
        id: data[0]?.id,
      }
    })
      // setWs(socket)
      socket?.addEventListener('open', () => {
        console.log('open')
      })
      socket?.addEventListener('close', () => {
        console.log('close')
      })
      socket?.addEventListener('message', (e) => {
        // const message = JSON.parse(e.data);
        const data = JSON.parse(e.data)
        setUpateStatus(data.message)
      })
    }
    return () => {
      socket?.close();
      // setWs(null)
    };
  }, [data, isPending])

  // if (isPending) return <LoaderContent />
  if (error) return 'An error has occurred: ' + error.message
  return (
    <div className='w-full h-full flex items-center justify-center'>
    <Tabs defaultValue="upload" className={`w-[400px] min-h-[${minHeight}px]`}>
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="upload">Service Account</TabsTrigger>
        <TabsTrigger value="oauth">Google OAuth</TabsTrigger>
      </TabsList>
      <TabsContent value="upload">
        {isPending ? <LoaderContent/> : 
          <ServiceAccountTab
            connectors={data}
            updateStatus={updateStatus}
            isIntegrating={isIntegratingSA}
            onSuccess={() => setIsIntegratingSA(true)} />
          }
      </TabsContent>
      <TabsContent value="oauth">
        {oauthIntegrationStatus === OAuthIntegrationStatus.Provider? (<OAuthForm onSuccess={() => setOAuthIntegrationStatus(OAuthIntegrationStatus.OAuth)} />) : 
          oauthIntegrationStatus === OAuthIntegrationStatus.OAuth ? (<Card>
            <CardHeader>
              <CardTitle>Google OAuth</CardTitle>
              <CardDescription>Connect using Google OAuth here.</CardDescription>
            </CardHeader>
            <CardContent>
              <OAuthButton app={Apps.GoogleDrive} setOAuthIntegrationStatus={setOAuthIntegrationStatus} text="Connect with Google OAuth" />
            </CardContent>
          </Card>) : (
            <Card>
            <CardHeader>
              <CardTitle>Google OAuth</CardTitle>
              {oauthIntegrationStatus === OAuthIntegrationStatus.OAuthConnecting && <CardDescription>status: {updateStatus} </CardDescription>}
            </CardHeader>
            <CardContent>
              {oauthIntegrationStatus === OAuthIntegrationStatus.OAuthConnected ? "Connected" : "Connecting"}
            </CardContent>
          </Card>
          )
        }
      </TabsContent>
    </Tabs>
    </div>
  );
};

export const Route = createFileRoute('/_authenticated/admin/integrations')({
  component: AdminLayout,
});
