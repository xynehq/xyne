import { createFileRoute, redirect } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { api } from "@/api"
import { errorComponent } from "@/components/error"

// Import assets using Vite's asset handling
import xyneLogoSvg from "@/assets/xyne-logo.svg"
import signinBackgroundPng from "@/assets/signin-background.png"
import signinCenterImagePng from "@/assets/signin-center-image.png"
import googleIconSvg from "@/assets/google-icon.svg"


const XyneLogo = () => (
  <img 
    src={xyneLogoSvg} 
    alt="Xyne Logo" 
    width="120" 
    height="25"
    className="object-contain"
  />
)

export default function LoginForm() {
  const handleGoogleLogin = async () => {
    try {
    const redirectUrl = `${window.location.origin}/v1/auth/callback`
    console.log("Redirecting to:", redirectUrl)
    window.location.href = redirectUrl
   }catch (error) {
    console.error("Failed to load config:", error)
   }
  }

  return (
    <div 
      className="w-full h-screen relative bg-cover bg-center bg-no-repeat flex items-center justify-center light bg-white"
      style={{
        backgroundImage: `url('${signinBackgroundPng}')`
      }}
      data-theme="light"
    >
      {/* Main Container - centered login layout */}
      <div 
        className="bg-white rounded-3xl overflow-hidden absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-black max-w-[1168px] h-[630px] px-[17px] py-[13px]"
      >
        {/* Horizontal Flex Container */}
        <div className="flex w-full h-full gap-4">
          
          {/* Left Section - Hero Content */}
          <div 
            className="relative bg-cover bg-center bg-no-repeat flex items-center justify-center rounded-2xl overflow-hidden w-[619px] h-[604px]"
            style={{
              backgroundImage: `linear-gradient(180deg, rgba(0, 0, 0, 0.00) 44.74%, rgba(0, 0, 0, 0.56) 117.43%), url('${signinCenterImagePng}')`
            }}
          >
            {/* Text Content */}
            <div 
              className="relative z-10 text-white flex flex-col items-start h-full pt-[60%] pl-[30px] pr-[65px] pb-[45px] gap-4"
            >
              {/* Main Heading */}
              <h1 
                className="text-[32px] font-semibold leading-normal tracking-[0.2px] max-w-[400px] -ml-[15px]"
              >
                The Unified AI Platform<br />for your enterprise
              </h1>
              
              {/* Description */}
              <p 
                className="text-base font-normal leading-normal tracking-[0.2px] text-white/90 -ml-[15px]"
              >
                The full-stack AI OS that's open-source,<br />on-prem, and enterprise-grade with determinism &<br />governance built-in by design.
              </p>
            </div>
          </div>
          
          {/* Right Section - Login Form */}
          <div 
            className="rounded-2xl flex flex-col items-center justify-center text-black w-[533px] h-[604px] px-10 pt-[45px] pb-[50px] gap-[70px] bg-transparent"
          >
            {/* Xyne Logo */}
            <div className="-mt-5">
              <XyneLogo />
            </div>
            
            {/* Welcome Section and Button */}
            <div className="w-full flex flex-col items-center gap-[50px]">
              {/* Welcome Text */}
              <div className="text-center flex flex-col gap-2">
                <h2 
                  className="font-bold text-xl font-inter text-[#3B4145] leading-normal"
                >
                  Welcome Back
                </h2>
                <p 
                  className="text-xs font-inter font-normal text-[#788187] leading-normal"
                >
                  Please click on the button to sign in
                </p>
              </div>
              
              {/* Google Sign In Button */}
              <Button
                className="h-12 bg-black text-white hover:bg-gray-800 flex items-center justify-center gap-3 rounded-full text-sm font-inter font-medium w-[409px] mt-10"
                onClick={handleGoogleLogin}
              >
                <img 
                  src={googleIconSvg} 
                  alt="Google" 
                  className="h-5 w-5"
                />
                Continue with google
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute("/auth")({
  beforeLoad: async () => {
    // Get user timezone
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

    const res = await api.me.$get({
      query: { timeZone },
    })
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
