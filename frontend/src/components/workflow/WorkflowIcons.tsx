import React from "react"
import { FileText } from "lucide-react"

interface IconProps {
  className?: string
  width?: number
  height?: number
}

// Tool Icons
export const DelayIcon: React.FC<IconProps> = ({
  className = "w-4 h-4",
  width = 24,
  height = 24,
}) => (
  <svg
    className={className}
    width={width}
    height={height}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <circle cx="12" cy="12" r="10"></circle>
    <polyline points="12 6 12 12 16 14"></polyline>
  </svg>
)

export const PythonScriptIcon: React.FC<IconProps> = ({
  className = "w-4 h-4",
  width = 24,
  height = 24,
}) => (
  <svg
    className={className}
    width={width}
    height={height}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <polyline points="16 18 22 12 16 6"></polyline>
    <polyline points="8 6 2 12 8 18"></polyline>
  </svg>
)

export const DefaultToolIcon: React.FC<IconProps> = ({
  className = "w-4 h-4",
  width = 24,
  height = 24,
}) => (
  <svg
    className={className}
    width={width}
    height={height}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <rect x="7" y="7" width="10" height="6" rx="1"></rect>
  </svg>
)

// Header Icons
export const EditorIcon: React.FC<IconProps> = ({
  className = "w-3.5 h-3.5",
  width = 24,
  height = 24,
}) => (
  <svg
    className={className}
    width={width}
    height={height}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
  </svg>
)

export const SettingsIcon: React.FC<IconProps> = ({
  className = "w-3.5 h-3.5",
  width = 24,
  height = 24,
}) => (
  <svg
    className={className}
    width={width}
    height={height}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <circle cx="12" cy="12" r="3"></circle>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
  </svg>
)

// Trigger Icons
export const ManualTriggerIcon: React.FC<IconProps> = ({
  className = "",
  width = 20,
  height = 20,
}) => (
  <svg
    className={className}
    width={width}
    height={height}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <circle cx="12" cy="12" r="10"></circle>
    <line x1="12" y1="8" x2="12" y2="16"></line>
    <line x1="8" y1="12" x2="16" y2="12"></line>
  </svg>
)

export const AppEventIcon: React.FC<IconProps> = ({
  className = "",
  width = 20,
  height = 20,
}) => (
  <svg
    className={className}
    width={width}
    height={height}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
    <line x1="8" y1="21" x2="16" y2="21"></line>
    <line x1="12" y1="17" x2="12" y2="21"></line>
  </svg>
)

export const ScheduleIcon: React.FC<IconProps> = ({
  className = "",
  width = 20,
  height = 20,
}) => (
  <svg
    className={className}
    width={width}
    height={height}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <circle cx="12" cy="12" r="10"></circle>
    <polyline points="12 6 12 12 16 14"></polyline>
  </svg>
)

export const WebhookIcon: React.FC<IconProps> = ({
  className = "",
  width = 20,
  height = 20,
}) => (
  <svg
    className={className}
    width={width}
    height={height}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
    <polyline points="15 3 21 3 21 9"></polyline>
    <line x1="10" y1="14" x2="21" y2="3"></line>
  </svg>
)

export const HttpRequestIcon: React.FC<IconProps> = ({
  className = "",
  width = 20,
  height = 20,
}) => (
  <svg
    className={className}
    width={width}
    height={height}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <circle cx="12" cy="12" r="10"></circle>
    <line x1="2" y1="12" x2="22" y2="12"></line>
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
  </svg>
)

export const FormSubmissionIcon: React.FC<IconProps> = ({
  className = "",
  width = 20,
  height = 20,
}) => (
  <FileText
    className={className}
    width={width}
    height={height}
  />
)

export const WorkflowExecutionIcon: React.FC<IconProps> = ({
  className = "",
  width = 20,
  height = 20,
}) => (
  <svg
    className={className}
    width={width}
    height={height}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
  </svg>
)

export const ChatMessageIcon: React.FC<IconProps> = ({
  className = "",
  width = 20,
  height = 20,
}) => (
  <svg
    className={className}
    width={width}
    height={height}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
  </svg>
)

// Resource Icons
export const HelpIcon: React.FC<IconProps> = ({
  className = "",
  width = 20,
  height = 20,
}) => (
  <svg
    className={className}
    width={width}
    height={height}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <circle cx="12" cy="12" r="10"></circle>
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
    <line x1="12" y1="17" x2="12.01" y2="17"></line>
  </svg>
)

export const TemplatesIcon: React.FC<IconProps> = ({
  className = "",
  width = 20,
  height = 20,
}) => (
  <svg
    className={className}
    width={width}
    height={height}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
    <line x1="16" y1="13" x2="8" y2="13"></line>
    <line x1="16" y1="17" x2="8" y2="17"></line>
  </svg>
)

// Empty Canvas Icon
export const AddIcon: React.FC<IconProps> = ({
  className = "w-5 h-5",
  width = 24,
  height = 24,
}) => (
  <svg
    className={className}
    width={width}
    height={height}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
  >
    <line x1="12" y1="5" x2="12" y2="19"></line>
    <line x1="5" y1="12" x2="19" y2="12"></line>
  </svg>
)

// Form Document Icon
export const FormDocumentIcon: React.FC<IconProps> = ({
  className = "",
  width = 16,
  height = 16,
}) => (
  <svg
    className={className}
    xmlns="http://www.w3.org/2000/svg"
    width={width}
    height={height}
    viewBox="0 0 16 16"
    fill="none"
    style={{ aspectRatio: "1/1" }}
  >
    <path
      d="M10.794 1.33301C12.8533 1.33301 14 2.51967 14 4.55301V11.4397C14 13.5063 12.8533 14.6663 10.794 14.6663H5.20667C3.18 14.6663 2 13.5063 2 11.4397V4.55301C2 2.51967 3.18 1.33301 5.20667 1.33301H10.794ZM5.38667 10.493C5.18667 10.473 4.99333 10.5663 4.88667 10.7397C4.78 10.9063 4.78 11.1263 4.88667 11.2997C4.99333 11.4663 5.18667 11.5663 5.38667 11.5397H10.6133C10.8793 11.513 11.08 11.2857 11.08 11.0197C11.08 10.7463 10.8793 10.5197 10.6133 10.493H5.38667ZM10.6133 7.45234H5.38667C5.09933 7.45234 4.86667 7.68634 4.86667 7.97301C4.86667 8.25967 5.09933 8.49301 5.38667 8.49301H10.6133C10.9 8.49301 11.1333 8.25967 11.1333 7.97301C11.1333 7.68634 10.9 7.45234 10.6133 7.45234ZM7.37933 4.43301H5.38667V4.43967C5.09933 4.43967 4.86667 4.67301 4.86667 4.95967C4.86667 5.24634 5.09933 5.47967 5.38667 5.47967H7.37933C7.66667 5.47967 7.9 5.24634 7.9 4.95234C7.9 4.66634 7.66667 4.43301 7.37933 4.43301Z"
      fill="#395A0C"
    />
  </svg>
)

// Connection Point Circle
export const ConnectionPointIcon: React.FC<IconProps> = ({
  className = "",
  width = 12,
  height = 12,
}) => (
  <svg
    className={className}
    xmlns="http://www.w3.org/2000/svg"
    width={width}
    height={height}
    viewBox="0 0 12 12"
    fill="none"
  >
    <circle cx="6" cy="6" r="5.5" fill="white" stroke="#A0A7AB" />
  </svg>
)

// Vertical Connection Line
export const VerticalLineIcon: React.FC<IconProps> = ({
  className = "",
  width = 2,
  height = 26,
}) => (
  <svg
    className={className}
    xmlns="http://www.w3.org/2000/svg"
    width={width}
    height={height}
    viewBox="0 0 2 26"
    fill="none"
  >
    <path
      d="M1 1V25"
      stroke="#C9CCCF"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
)

// Plus Icon for Forms
export const FormPlusIcon: React.FC<IconProps> = ({
  className = "",
  width = 16,
  height = 16,
}) => (
  <svg
    className={className}
    xmlns="http://www.w3.org/2000/svg"
    width={width}
    height={height}
    viewBox="0 0 16 16"
    fill="none"
  >
    <path
      d="M7.99967 12.6663V7.99967M7.99967 7.99967V3.33301M7.99967 7.99967L3.33301 7.99967M7.99967 7.99967L12.6663 7.99967"
      stroke="#788187"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

// Back Arrow Icon
export const BackArrowIcon: React.FC<IconProps> = ({
  className = "",
  width = 24,
  height = 24,
}) => (
  <svg
    className={className}
    xmlns="http://www.w3.org/2000/svg"
    width={width}
    height={height}
    viewBox="0 0 24 24"
    fill="none"
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M20.958 10.9995H7.38002L12.422 5.97852L11.011 4.56152L3.54102 12.0005L11.011 19.4385L12.422 18.0215L7.37802 12.9995H20.958V10.9995Z"
      fill="#181B1D"
    />
  </svg>
)

// Close/X Icon
export const CloseIcon: React.FC<IconProps> = ({
  className = "",
  width = 24,
  height = 24,
}) => (
  <svg
    className={className}
    xmlns="http://www.w3.org/2000/svg"
    width={width}
    height={height}
    viewBox="0 0 24 24"
    fill="none"
  >
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M13.4142 12.0002L18.7072 6.70725C19.0982 6.31625 19.0982 5.68425 18.7072 5.29325C18.3162 4.90225 17.6842 4.90225 17.2932 5.29325L12.0002 10.5862L6.70725 5.29325C6.31625 4.90225 5.68425 4.90225 5.29325 5.29325C4.90225 5.68425 4.90225 6.31625 5.29325 6.70725L10.5862 12.0002L5.29325 17.2933C4.90225 17.6842 4.90225 18.3162 5.29325 18.7072C5.48825 18.9022 5.74425 19.0002 6.00025 19.0002C6.25625 19.0002 6.51225 18.9022 6.70725 18.7072L12.0002 13.4143L17.2932 18.7072C17.4882 18.9022 17.7442 19.0002 18.0002 19.0002C18.2562 19.0002 18.5122 18.9022 18.7072 18.7072C19.0982 18.3162 19.0982 17.6842 18.7072 17.2933L13.4142 12.0002Z"
      fill="black"
    />
  </svg>
)

// Jira Icon
export const JiraIcon: React.FC<IconProps> = ({
  className = "",
  width = 24,
  height = 24,
}) => {
  const gradientId = React.useId()
  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Jira"
    >
      <path
        d="M11.5714 0L6.28571 5.28571L1.71429 9.85714L0 11.5714L11.5714 23.1429L13.2857 21.4286L7.71429 15.8571L13 10.5714L18.2857 5.28571L13 0H11.5714Z"
        fill="#2684FF"
      />
      <path
        d="M11.5714 11.5714L7 16.1429L11.5714 20.7143L16.1429 16.1429L11.5714 11.5714Z"
        fill={`url(#${gradientId})`}
      />
      <defs>
        <linearGradient
          id={gradientId}
          x1="7"
          y1="16.1429"
          x2="16.1429"
          y2="16.1429"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#0052CC" />
          <stop offset="1" stopColor="#2684FF" />
        </linearGradient>
      </defs>
    </svg>
  )
}
