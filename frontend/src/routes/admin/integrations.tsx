import { Button } from '@/components/ui/button';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Apps } from '@server/types';
import { api } from '@/api';
// import { useToast } from "@/components/hooks/use-toast"
import { useToast } from "@/hooks/use-toast"
import { useForm } from '@tanstack/react-form';


import { ToastAction } from "@/components/ui/toast"
import { cn } from '@/lib/utils';

export const InputFile = ({setLoadingServiceAccount}) => {
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
      // If no file, stop submission
      if (!value.file) {
        toast({
          title: "No file selected",
          description: "Please upload a file before submitting.",
          variant: 'destructive',
        });
        return;
      }
      console.log(value)

      try {
        const response = await api.api.admin.service_account.$post({
          form: {
            'service-key': value.file,
            'app': Apps.GoogleDrive,
            'email': value.email,  // Pass email along with the file
          }
        });

        if (response.ok) {
          toast({
            title: "File uploaded successfully",
            description: "Integration in progress",
          });
          setLoadingServiceAccount(true);
        } else {
          const errorText = await response.text();
          toast({
            title: "Could not upload the service key",
            description: `Error: ${errorText}`,
            variant: 'destructive',
          });
          throw new Error(`Failed to upload file: ${response.status} ${response.statusText} - ${errorText}`);
        }
      } catch (error) {
        console.error('Error uploading file:', error);
      }
    },
  });
  // const handleSubmit = async (event: React.FormEvent) => {
  //   event.preventDefault();
  //   if (!selectedFile) return;

  //   try {
  //     const response = await api.api.admin.service_account.$post({
  //       form: {
  //         'service-key': selectedFile,
  //         'app': Apps.GoogleDrive,
  //         'email': email,  // Pass email along with the file

  //       }
  //     });
  //     if (response.ok) {
  //       toast({
  //         title: "File uploaded successfully",
  //         description: "integration in progress",
  //         // action: (
  //         //   <ToastAction altText="Goto schedule to undo">Undo</ToastAction>
  //         // ),
  //       })
  //       setLoadingServiceAccount(true)
  //     } else {
  //       const errorText = await response.text();
  //       toast({
  //         title: "Could not upload the service key",
  //         description: `error: ${errorText}`,
  //         variant: 'destructive'
  //         // action: (
  //         //   <ToastAction altText="Goto schedule to undo">Undo</ToastAction>
  //         // ),
  //       })
  //       throw new Error(`Failed to upload file: ${response.status} ${response.statusText} - ${errorText}`);
  //     }
  //   } catch (error) {
  //     console.error('Error uploading file:', error);
  //   }
  // };

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

const AdminLayout = () => {
  const [loadingServiceAccount, setLoadingServiceAccount] = useState(false);
  return (
    <div className='w-full h-full flex items-center justify-center'>
    <Tabs defaultValue="upload" className={`w-[400px] min-h-[${minHeight}px]`}>
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="upload">Service Account</TabsTrigger>
        <TabsTrigger value="oauth">Google OAuth</TabsTrigger>
      </TabsList>
      <TabsContent value="upload">
        {!loadingServiceAccount ? (
        <Card>
          <CardHeader>
            <CardTitle>File Upload</CardTitle>
            <CardDescription>Upload your Google Service Account Key here.</CardDescription>
          </CardHeader>
          <CardContent>
            <InputFile setLoadingServiceAccount={setLoadingServiceAccount} />
          </CardContent>
        </Card>

        ) : (
          <div className={`min-h-[${minHeight}px] w-full flex items-center justify-center`}>
            <div className='items-center justify-center'>
              <LoadingSpinner className="mr-2 h-4 w-4 animate-spin" />
            </div>
          </div>
        )}
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
