import { Button } from '@/components/ui/button';
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Apps } from '@server/types';
import { api, wsClient } from '@/api';
// import { useToast } from "@/components/hooks/use-toast"
import { useToast } from "@/hooks/use-toast"
import { useForm } from '@tanstack/react-form';


import { ToastAction } from "@/components/ui/toast"
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';

const submitServiceAccountForm = async (value) => {
    const response = await api.api.admin.service_account.$post({
      form: {
        'service-key': value.file,
        'app': Apps.GoogleDrive,
        'email': value.email,  // Pass email along with the file
      }
    });
    if(!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to upload file: ${response.status} ${response.statusText} - ${errorText}`);
    }
    return response.json()
}

export const InputFile = ({onSuccess}) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const { toast } = useToast();

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setSelectedFile(file);
    }
  };


  const form = useForm({
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
        const response = await submitServiceAccountForm(value);  // Call the async function
        toast({
          title: "File uploaded successfully",
          description: "Integration in progress",
        });
        onSuccess()
      } catch (error) {
        toast({
          title: "Could not upload the service account key",
          description: `Error: ${error.message}`,
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

function GoogleOAuthButton() {
  const handleOAuth = async () => {
    // Add OAuth handling code here
    alert('Google OAuth triggered');
  };

  return (
    <Button onClick={handleOAuth}>
      Connect with Google OAuth
    </Button>
  );
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

const getConnectors = async () => {
  const res = await api.api.admin.connectors.all.$get()
  if(!res.ok) {
    if(res.status === 401) {
      throw new Error('Unauthorized')
    }
    throw new Error('Could not get connectors')
  }
  return res.json()
}

const ServiceAccountTab = ({connectors, updateStatus, onSuccess, isIntegrating}) => {
  if(!isIntegrating) {
        return (<Card>
          <CardHeader>
            <CardTitle>File Upload</CardTitle>
            <CardDescription>Upload your Google Service Account Key here.</CardDescription>
          </CardHeader>
          <CardContent>
            <InputFile onSuccess={onSuccess} />
          </CardContent>
        </Card>)
  } else {
    return (<CardHeader>
      <CardTitle>{connectors[0]?.app}</CardTitle>
      <CardDescription>Connecting App</CardDescription>
      <CardContent className='pt-0'>
        <p>updates: {updateStatus}</p>
        <p>status: {connectors[0]?.status}</p>
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

const AdminLayout = () => {
  const navigator = useNavigate()
  const {isPending, error, data } = useQuery({ queryKey: ['all-connectors'], queryFn: async () => {
    try {
      return await getConnectors()
    } catch(e) {
      if(e.message === 'Unauthorized') {
        navigator({to: '/auth'})
        return []
      }
      throw e
    }
  }})
  const [ws, setWs] = useState(null);
  const [updateStatus, setUpateStatus] = useState('')
  const [isIntegrating, setIsIntegrating] = useState(data?.length > 0)

  useEffect(() => {
    if (!isPending && data && data.length > 0) {
      setIsIntegrating(true);
    } else {
      setIsIntegrating(false);
    }
  }, [data, isPending]);

  useEffect(() => {
    let socket = null
    if(!isPending && data && data.length > 0) {
      const socket = wsClient.ws.$ws({
      query: {
        id: data[0]?.id,
      }
    })
      setWs(socket)
      socket.addEventListener('open', () => {
        console.log('open')
      })
      socket.addEventListener('close', () => {
        console.log('close')
      })
      socket.addEventListener('message', (e) => {
        // const message = JSON.parse(e.data);
        const data = JSON.parse(e.data)
        setUpateStatus(data.message)
      })
    }
    return () => {
      socket?.close();
      setWs(null)
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
            isIntegrating={isIntegrating}
            onSuccess={() => setIsIntegrating(true)} />
          }
      </TabsContent>
      <TabsContent value="oauth">
        <Card>
          <CardHeader>
            <CardTitle>Google OAuth</CardTitle>
            <CardDescription>Connect using Google OAuth here.</CardDescription>
          </CardHeader>
          <CardContent>
            <GoogleOAuthButton />
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
    </div>
  );
};

export const Route = createFileRoute('/admin/integrations')({
  component: AdminLayout,
});
