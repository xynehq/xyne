import { useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { api } from "@/api"
import { errorComponent } from "@/components/error"

export const description =
  "A login form with email and password. There's an option to login with Google and a link to sign up if you don't have an account."

export const containerClassName =
  "w-full h-screen flex items-center justify-center px-4"

export default function LoginForm() {
  const logger = console
  const [showModal, setShowModal] = useState(false);
  const [modalMessage, setModalMessage] = useState("");

  const handleLogin = async () => {
    try {
      const response = await fetch(
        `${import.meta.env.VITE_API_BASE_URL}/v1/credential/status`,
        { method: "GET"}
      );
      // Error - Modal pops up
      if (response.status === 500)  {
        const data = await response.json();
        if (data.message === "EnvError: Google OAuth credentials are not configured") {
          logger.warn("Google OAuth credentials are not configured.");
          setModalMessage(
            "EnvError: Google OAuth credentials are not configured. Please configure the Google Credentials in your .env.temp file."
          );
          setShowModal(true); 
          return;
        }
      }
      // No Error - Proceed with authentication
      const redirectUrl = `${import.meta.env.VITE_API_BASE_URL}/v1/auth/callback`;
      window.location.href = redirectUrl;
    } catch (error) {
      logger.error("An error occurred during login:", error);
      setModalMessage(
        "An unexpected error occurred. Please try again later."
      );
      setShowModal(true); 
    }
  };
  return (
    <div className="flex w-full h-full justify-center">
      <div className="max-w-sm flex items-center">
        <Card className="h-auto">
          <CardHeader>
            <CardTitle className="text-2xl">Login</CardTitle>
            <CardDescription>
              Login with your workspace Google account
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4">
              <Button
                variant="outline"
                className="w-full"
                onClick={handleLogin}
              >
                Login with Google
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-xl font-bold text-red-600">
              Configuration Error
            </DialogTitle>
            <DialogDescription className="text-gray-600">
              {modalMessage}
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export const Route = createFileRoute("/auth")({
  beforeLoad: async () => {
    const res = await api.me.$get()
    if (res.ok) {
      // TODO: to type this response
      const userWorkspace = await res.json()
      // If User & Workspace exists, don't let user visit /auth
      if (userWorkspace?.user && userWorkspace?.workspace) {
        throw redirect({ to: "/" })
      }
      return await res.json()
    }
  },
  component: LoginForm,
  errorComponent: errorComponent,
})
