import { createFileRoute, useRouterState, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { Sidebar } from "@/components/Sidebar"
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu"
import { getIcon } from "@/lib/common"
import { getName } from "@/components/GroupFilter" // Re-added for MessageCitationList styling
import { Apps, ChatSSEvents, SelectPublicMessage, Citation, PublicUser, SelectPublicAgent } from "shared/types"
import { ChevronDown, X as LucideX, Check, RotateCcw, PlusCircle, Copy, ArrowLeft, Edit3, Trash2 } from "lucide-react"
import { useState, useMemo, useEffect, useRef } from "react"
import MarkdownPreview from "@uiw/react-markdown-preview"
import { api } from "@/api"
import AssistantLogo from "@/assets/assistant-logo.svg"
import RetryAsset from "@/assets/retry.svg"   // Renamed
import { splitGroupedCitationsWithSpaces } from "@/lib/utils"
import {
  TooltipProvider,
} from "@/components/ui/tooltip"
import { toast, useToast } from "@/hooks/use-toast" // Assuming useToast is the correct hook
import { ChatBox } from "@/components/ChatBox" // Assuming ChatBox is made a common component

type CurrentResp = {
  resp: string;
  chatId?: string;
  messageId?: string;
  sources?: Citation[];
  citationMap?: Record<number, number>;
  thinking?: string;
};

const REASONING_STATE_KEY = "isAgentReasoningGlobalState";

export const Route = createFileRoute('/_authenticated/agent')({
  validateSearch: z.object({
    agentId: z.string().optional(),
  }),
  component: AgentComponent,
})

// Custom Badge Component
interface CustomBadgeProps {
  text: string;
  onRemove: () => void;
  icon?: React.ReactNode;
}
const CustomBadge: React.FC<CustomBadgeProps> = ({ text, onRemove, icon }) => {
  return (
    <div className="flex items-center justify-center bg-slate-100 text-slate-700 text-xs font-medium pl-2 pr-1 py-1 rounded-md border border-slate-200">
      {icon && <span className="mr-1 flex items-center">{icon}</span>} {/* Reduced mr-1.5 to mr-1 */}
      <span>{text}</span>
      <LucideX
        className="ml-1.5 h-3.5 w-3.5 cursor-pointer hover:text-red-500"
        onClick={(e) => {
          e.stopPropagation(); 
          onRemove();
        }}
      />
    </div>
  );
};

interface IntegrationSource {
  id: string;
  name: string;
  app: Apps | string; 
  entity: string;    
  icon: React.ReactNode;
}

// Updated to only include Transcripts
const availableIntegrationsList: IntegrationSource[] = [
  { id: 'transcripts', name: 'Transcripts', app: 'custom', entity: 'transcript', icon: getIcon('file-text', "file", { w: 12, h: 12 , mr: 0.5 }) } // Icon size 12x12, further reduced margin
];

function AgentComponent() {
  const { agentId } = Route.useSearch();
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState<'list' | 'create' | 'edit'>('list');
  const [agents, setAgents] = useState<SelectPublicAgent[]>([]);
  const [editingAgent, setEditingAgent] = useState<SelectPublicAgent | null>(null);
  const [selectedChatAgentExternalId, setSelectedChatAgentExternalId] = useState<string | null>(null);
  const [initialChatAgent, setInitialChatAgent] = useState<SelectPublicAgent | null>(null);
  const [isLoadingInitialAgent, setIsLoadingInitialAgent] = useState(false);

  const [selectedModel, setSelectedModel] = useState("Auto"); // Default model for test chat if not specified by saved agent

  const [agentName, setAgentName] = useState("");
  const [agentDescription, setAgentDescription] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");

  const [selectedIntegrations, setSelectedIntegrations] = useState<Record<string, boolean>>({});
  const [isIntegrationMenuOpen, setIsIntegrationMenuOpen] = useState(false);
  // const [allowWebSearch, setAllowWebSearch] = useState(false); // Removed
  // const [uploadedFiles, setUploadedFiles] = useState<File[]>([]); // Removed

  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<SelectPublicMessage[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [currentResp, setCurrentResp] = useState<CurrentResp | null>(null);
  const [stopMsg, setStopMsg] = useState<boolean>(false);

  const currentRespRef = useRef<CurrentResp | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [userHasScrolled, setUserHasScrolled] = useState(false);
  const [dots, setDots] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [allCitations, _] = useState<Map<string, Citation>>(new Map());
  const eventSourceRef = useRef<EventSource | null>(null);
  const [userStopped, setUserStopped] = useState<boolean>(false);

  const [isReasoningActive, setIsReasoningActive] = useState(() => {
    const storedValue = localStorage.getItem(REASONING_STATE_KEY);
    return storedValue ? JSON.parse(storedValue) : false;
  });

  useEffect(() => {
    localStorage.setItem(REASONING_STATE_KEY, JSON.stringify(isReasoningActive));
  }, [isReasoningActive]);

  const matches = useRouterState({ select: (s) => s.matches });
  const { user } = matches[matches.length - 1].context as { user: PublicUser };
  const { toast: showToast } = useToast();

  // Effect to fetch agent data if agentId is present in URL for the chatbox
  useEffect(() => {
    const fetchInitialAgentForChat = async () => {
      if (agentId) {
        setIsLoadingInitialAgent(true);
        setInitialChatAgent(null); 
        try {
          const response = await api.agent[":agentExternalId"].$get({
            param: { agentExternalId: agentId },
          });
          if (response.ok) {
            const agentData = await response.json() as SelectPublicAgent;
            setInitialChatAgent(agentData);
          } else {
            showToast({ title: "Error", description: `Failed to load agent ${agentId} for chat.`, variant: "destructive" });
          }
        } catch (error) {
          showToast({ title: "Error", description: "An error occurred while loading agent for chat.", variant: "destructive" });
          console.error("Fetch initial agent for chat error:", error);
        } finally {
          setIsLoadingInitialAgent(false);
        }
      } else {
        setInitialChatAgent(null); 
      }
    };

    fetchInitialAgentForChat();
  }, [agentId, showToast]);

  const fetchAgents = async () => {
    try {
      const response = await api.agents.$get();
      if (response.ok) {
        const data = await response.json();
        setAgents(data as SelectPublicAgent[]);
      } else {
        showToast({ title: "Error", description: "Failed to fetch agents.", variant: "destructive" });
      }
    } catch (error) {
      showToast({ title: "Error", description: "An error occurred while fetching agents.", variant: "destructive" });
      console.error("Fetch agents error:", error);
    }
  };

  useEffect(() => {
    if (viewMode === 'list') {
      fetchAgents();
    }
  }, [viewMode]);

  const resetForm = () => {
    setAgentName("");
    setAgentDescription("");
    setAgentPrompt("");
    setSelectedModel("Auto");
    setSelectedIntegrations({});
    // setAllowWebSearch(false); // Removed
    // setUploadedFiles([]); // Removed
    setEditingAgent(null);
  };

  const handleCreateNewAgent = () => {
    resetForm();
    setViewMode('create');
  };

  const handleEditAgent = (agent: SelectPublicAgent) => {
    setAgentName(agent.name);
    setAgentDescription(agent.description || "");
    setAgentPrompt(agent.prompt || "");
    setSelectedModel(agent.model); 
    const currentIntegrations: Record<string, boolean> = {};
    availableIntegrationsList.forEach(int => {
      currentIntegrations[int.id] = agent.appIntegrations?.includes(int.id) || false;
    });
    setSelectedIntegrations(currentIntegrations);
    // setAllowWebSearch(agent.allowWebSearch || false); // Removed
    // setUploadedFiles([]);  // Removed
    setEditingAgent(agent);
    setViewMode('create');
  };
  
  const handleDeleteAgent = async (agentExternalId: string) => {
    if (!window.confirm("Are you sure you want to delete this agent? This action cannot be undone.")) {
      return;
    }
    try {
      const response = await api.agent[":agentExternalId"].$delete({
        param: { agentExternalId },
      });
      if (response.ok) {
        showToast({ title: "Success", description: "Agent deleted successfully." });
        setAgents(prevAgents => prevAgents.filter(agent => agent.externalId !== agentExternalId));
      } else {
        let errorDetail = response.statusText;
        try {
          const errorData = await response.json();
          errorDetail = errorData.message || errorData.detail || response.statusText;
        } catch (e) {
          console.error("Failed to parse error response as JSON", e);
        }
        showToast({ title: "Error", description: `Failed to delete agent: ${errorDetail}`, variant: "destructive" });
      }
    } catch (error) {
      showToast({ title: "Error", description: "An error occurred while deleting the agent.", variant: "destructive" });
      console.error("Delete agent error:", error);
    }
  };

  const handleSaveAgent = async () => {
    const enabledIntegrations = Object.entries(selectedIntegrations)
      .filter(([, isSelected]) => isSelected)
      .map(([id]) => id);
    
    const agentPayload = {
      name: agentName,
      description: agentDescription,
      prompt: agentPrompt,
      model: selectedModel, 
      appIntegrations: enabledIntegrations,
      // allowWebSearch: allowWebSearch, // Removed
      // uploadedFileNames: uploadedFiles.map(f => f.name), // Removed
    };

    try {
      let response;
      if (editingAgent && editingAgent.externalId) {
        response = await api.agent[":agentExternalId"].$put({
          param: { agentExternalId: editingAgent.externalId },
          json: agentPayload,
        });
        if (response.ok) {
          showToast({ title: "Success", description: "Agent updated successfully." });
          setViewMode('list');
          resetForm();
        } else {
          const errorData = await response.json();
          showToast({ title: "Error", description: `Failed to update agent: ${errorData.message || response.statusText}`, variant: "destructive" });
        }
      } else {
        response = await api.agent.create.$post({ json: agentPayload });
        if (response.ok) {
          showToast({ title: "Success", description: "Agent created successfully." });
          setViewMode('list');
          resetForm();
        } else {
          const errorData = await response.json();
          showToast({ title: "Error", description: `Failed to create agent: ${errorData.message || response.statusText}`, variant: "destructive" });
        }
      }
    } catch (error) {
      const action = editingAgent ? "updating" : "creating";
      showToast({ title: "Error", description: `An error occurred while ${action} the agent.`, variant: "destructive" });
      console.error(`${action} agent error:`, error);
    }
  };

  const toggleIntegrationSelection = (integrationId: string) => {
    setSelectedIntegrations(prev => ({
      ...prev,
      [integrationId]: !prev[integrationId],
    }));
  };

  const handleRemoveSelectedIntegration = (integrationId: string) => {
    setSelectedIntegrations(prev => ({
      ...prev,
      [integrationId]: false,
    }));
  };

  const handleClearAllIntegrations = () => {
    const clearedSelection: Record<string, boolean> = {};
    availableIntegrationsList.forEach(int => clearedSelection[int.id] = false);
    setSelectedIntegrations(clearedSelection);
  };
  
  const currentSelectedIntegrationObjects = useMemo(() => {
    return availableIntegrationsList.filter(integration => selectedIntegrations[integration.id]);
  }, [selectedIntegrations]);

  // const onDrop = useCallback((acceptedFiles: File[]) => { // Removed
  //   setUploadedFiles(prevFiles => [...prevFiles, ...acceptedFiles]); // Removed
  //   console.log("Dropped files:", acceptedFiles.map(f=>f.name)); // Removed
  // }, []); // Removed

  // const handleFileSelectClick = () => { // Removed
  //   const fileInput = document.getElementById('fileUploadInput') as HTMLInputElement | null; // Removed
  //   fileInput?.click(); // Removed
  // }; // Removed

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
    }
  }, [])

  useEffect(() => {
    if (isStreaming) {
      const interval = setInterval(() => {
        setDots((prev) => (prev.length >= 3 ? "" : prev + "."))
      }, 500)
      return () => clearInterval(interval)
    } else {
      setDots("")
    }
  }, [isStreaming])

  const handleSend = async (messageToSend: string) => {
    if (!messageToSend || isStreaming) return;

    setUserHasScrolled(false);
    setQuery(""); 
    setMessages((prevMessages) => [
      ...prevMessages,
      { messageRole: "user", message: messageToSend, externalId: `user-${Date.now()}` },
    ]);

    setIsStreaming(true);
    setCurrentResp({ resp: "", thinking: "" });
    currentRespRef.current = { resp: "", sources: [], thinking: "" };

    const url = new URL(`/api/v1/message/create`, window.location.origin);

    // Determine agent configuration for the chat
    let chatConfigAgent: SelectPublicAgent | null | undefined = null;

    if (initialChatAgent) { // 1. Priority: Agent from URL (agentId)
      chatConfigAgent = initialChatAgent;
    } else if (selectedChatAgentExternalId) { // 2. Fallback: Agent selected in dropdown
      chatConfigAgent = agents.find(agent => agent.externalId === selectedChatAgentExternalId);
    }
    // 3. If neither, use current form values (agentPrompt, selectedModel, selectedIntegrations)

    let finalAgentPrompt = agentPrompt; // Default to form's current prompt
    let finalSelectedIntegrationNames = availableIntegrationsList
      .filter(integration => selectedIntegrations[integration.id])
      .map(integration => integration.name); // Default to form's current integrations
    let finalModelForChat = selectedModel; // Default to form's current model

    if (chatConfigAgent) {
      finalAgentPrompt = chatConfigAgent.prompt || "";
      finalSelectedIntegrationNames = availableIntegrationsList
        .filter(integration => chatConfigAgent.appIntegrations?.includes(integration.id))
        .map(integration => integration.name);
      finalModelForChat = chatConfigAgent.model;
    }

    const agentPromptPayload = {
      prompt: finalAgentPrompt,
      sources: finalSelectedIntegrationNames
    };
    
    console.log("Sending message to backend:", {
      message: messageToSend,
      agentPromptJson: agentPromptPayload,
      modelToUse: finalModelForChat,
      isReasoningActive
    });

    url.searchParams.append("modelId", finalModelForChat === "Auto" ? "gpt-4o-mini" : finalModelForChat);
    url.searchParams.append("message", encodeURIComponent(messageToSend));
    if (isReasoningActive) {
      url.searchParams.append("isReasoningEnabled", "true");
    }
    url.searchParams.append("agentPrompt", JSON.stringify(agentPromptPayload));

    eventSourceRef.current = new EventSource(url.toString(), {
      withCredentials: true,
    });

    eventSourceRef.current.addEventListener(
      ChatSSEvents.CitationsUpdate,
      (event) => {
        const { contextChunks, citationMap } = JSON.parse(event.data);
        if (currentRespRef.current) {
          currentRespRef.current.sources = contextChunks;
          currentRespRef.current.citationMap = citationMap;
          setCurrentResp((prevResp: CurrentResp | null) => ({
            ...(prevResp || { resp: "", thinking: "" }),
            resp: prevResp?.resp || "",
            sources: contextChunks,
            citationMap,
          }));
        }
      },
    );

    eventSourceRef.current.addEventListener(ChatSSEvents.Reasoning, (event) => {
      setCurrentResp((prevResp: CurrentResp | null) => ({
        ...(prevResp || { resp: "", thinking: event.data || "" }),
        thinking: (prevResp?.thinking || "") + event.data,
      }));
    });

    eventSourceRef.current.addEventListener(ChatSSEvents.Start, () => {});

    eventSourceRef.current.addEventListener(
      ChatSSEvents.ResponseUpdate,
      (event) => {
        setCurrentResp((prevResp: CurrentResp | null) => {
          const updatedResp = prevResp
            ? { ...prevResp, resp: prevResp.resp + event.data }
            : { resp: event.data, thinking: "", sources: [], citationMap: {} };
          currentRespRef.current = updatedResp;
          return updatedResp;
        });
      },
    );

    eventSourceRef.current.addEventListener(
      ChatSSEvents.ResponseMetadata,
      (event) => {
        const { chatId: newChatId, messageId } = JSON.parse(event.data);
        if (newChatId && !chatId) setChatId(newChatId); 
        if (messageId) {
          if (currentRespRef.current) {
            setCurrentResp((resp: CurrentResp | null) => {
              const updatedResp = resp || { resp: "", thinking: "" };
              updatedResp.chatId = newChatId;
              updatedResp.messageId = messageId;
              currentRespRef.current = updatedResp;
              return updatedResp;
            });
          }
        }
        if (!stopMsg) setStopMsg(true);
      },
    );

    eventSourceRef.current.addEventListener(ChatSSEvents.End, () => {
      const currentRespVal = currentRespRef.current;
      if (currentRespVal) {
        setMessages((prevMessages) => [
          ...prevMessages,
          {
            messageRole: "assistant",
            message: currentRespVal.resp,
            externalId: currentRespVal.messageId,
            sources: currentRespVal.sources,
            citationMap: currentRespVal.citationMap,
            thinking: currentRespVal.thinking,
          },
        ]);
      }
      setCurrentResp(null);
      currentRespRef.current = null;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      setStopMsg(false);
      setIsStreaming(false);
    });

    eventSourceRef.current.addEventListener(ChatSSEvents.Error, (event) => {
      console.error("Error with SSE:", event.data);
      const currentRespVal = currentRespRef.current;
      setMessages((prevMessages) => [
        ...prevMessages,
        {
          messageRole: "assistant",
          message: `Error: ${event.data || "Unknown error"}`,
          externalId: currentRespVal?.messageId || `err-${Date.now()}`,
          sources: currentRespVal?.sources,
          citationMap: currentRespVal?.citationMap,
          thinking: currentRespVal?.thinking,
        },
      ]);
      setCurrentResp(null);
      currentRespRef.current = null;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      setStopMsg(false);
      setIsStreaming(false);
    });

    eventSourceRef.current.onerror = (error) => {
      if (userStopped) {
        setUserStopped(false);
        setCurrentResp(null);
        currentRespRef.current = null;
        setStopMsg(false);
        setIsStreaming(false);
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
        return;
      }
      console.error("Error with SSE (onerror):", error);
      setMessages((prevMessages) => [
        ...prevMessages,
        {
          messageRole: "assistant",
          message: "An error occurred while streaming the response. Please try again.",
          externalId: `onerror-${Date.now()}`,
        },
      ]);
      setCurrentResp(null);
      currentRespRef.current = null;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      setStopMsg(false);
      setIsStreaming(false);
    };
    setQuery(""); 
  };

  const handleStop = async () => {
    setUserStopped(true);
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsStreaming(false);

    if (chatId && currentRespRef.current?.messageId) { 
      try {
        await api.chat.stop.$post({ 
          json: { chatId: chatId },
        });
      } catch (error) {
        console.error("Failed to send stop request to backend:", error);
        toast({
          title: "Error",
          description: "Could not stop streaming on backend.",
          variant: "destructive",
          duration: 1000,
        });
      }
    }

    if (currentRespRef.current && currentRespRef.current.resp) {
      setMessages((prevMessages) => [
        ...prevMessages,
        {
          messageRole: "assistant",
          message: currentRespRef.current?.resp || " ",
          externalId: currentRespRef.current?.messageId,
          sources: currentRespRef.current?.sources,
          citationMap: currentRespRef.current?.citationMap,
          thinking: currentRespRef.current?.thinking,
        },
      ]);
    }
    setCurrentResp(null);
    currentRespRef.current = null;
    setStopMsg(false);
  };

  const handleRetry = async (messageIdToRetry: string) => {
    const assistantMessageIndex = messages.findIndex(msg => msg.externalId === messageIdToRetry && msg.messageRole === 'assistant');
    if (assistantMessageIndex > 0) {
        const userMessageToResend = messages[assistantMessageIndex -1];
        if(userMessageToResend && userMessageToResend.messageRole === 'user') {
            setMessages(prev => prev.slice(0, assistantMessageIndex -1));
            await handleSend(userMessageToResend.message);
        } else {
            toast({ title: "Retry Error", description: "Could not find original user message to retry.", variant: "destructive" });
        }
    } else {
         toast({ title: "Retry Error", description: "Could not find message to retry.", variant: "destructive" });
    }
  };

  const isScrolledToBottom = () => {
    const container = messagesContainerRef.current;
    if (!container) return true;
    const threshold = 100;
    return (
      container.scrollHeight - container.scrollTop - container.clientHeight < threshold
    );
  };

  const handleScroll = () => {
    setUserHasScrolled(!isScrolledToBottom());
  };

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || userHasScrolled) return;
    container.scrollTop = container.scrollHeight;
  }, [messages, currentResp?.resp]);

  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-white">
      <Sidebar photoLink={user?.photoLink} role={user?.role} />
      <div className="flex flex-col md:flex-row flex-1 h-full md:ml-[60px]">
        <div className={`p-4 md:p-8 bg-white overflow-y-auto h-full relative ${viewMode === 'list' ? 'w-full' : 'w-full md:w-[50%] border-r border-gray-200'}`}>
          {viewMode === 'list' ? (
            <>
              <div className="flex justify-between items-center mb-8 w-full max-w-2xl mx-auto">
                <h1 className="text-2xl font-semibold text-gray-700">My Agents</h1>
                <Button onClick={handleCreateNewAgent} className="bg-slate-800 hover:bg-slate-700 text-white">
                  <PlusCircle size={18} className="mr-2" /> Create Agent
                </Button>
              </div>
              <div className="w-full max-w-2xl mx-auto">
                {agents.length === 0 ? (
                  <div className="text-center py-10 text-gray-500">
                    <p className="text-lg mb-2">No agents created yet.</p>
                    <p>Click "Create Agent" to get started.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    {agents.map(agent => (
                      <div key={agent.externalId} className="bg-white border border-gray-200 rounded-lg p-6 shadow-lg hover:shadow-xl transition-shadow flex flex-col justify-between">
                        <div 
                          className="cursor-pointer flex-grow" 
                          onClick={() => navigate({ to: '/', search: { agentId: agent.externalId } })}
                        >
                          <div className="flex justify-between items-start mb-3">
                            <h2 className="text-xl font-semibold text-gray-800 truncate" title={agent.name}>{agent.name}</h2>
                            {/* Edit and Delete buttons are outside the new clickable div to maintain their functionality */}
                          </div>
                          <p className="text-xs text-gray-500 mb-3">
                            Model: <span className="font-medium">{agent.model}</span>
                          </p>
                          <p className="text-sm text-gray-600 h-20 overflow-hidden text-ellipsis mb-4">
                            {agent.description || <span className="italic text-gray-400">No description provided.</span>}
                          </p>
                        </div>
                        <div className="flex justify-end items-center mt-auto pt-4 border-t border-gray-100"> {/* Added border for visual separation */}
                          <div className="flex space-x-2 flex-shrink-0">
                              <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); handleEditAgent(agent);}} className="h-8 w-8 text-gray-500 hover:text-gray-700 hover:bg-slate-100">
                                <Edit3 size={16} />
                              </Button>
                              <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); handleDeleteAgent(agent.externalId);}} className="h-8 w-8 text-red-500 hover:text-red-700 hover:bg-red-50">
                                <Trash2 size={16} />
                              </Button>
                          </div>
                          <p className="text-xs text-gray-400 text-right ml-auto"> {/* Pushed to right */}
                            Last updated: {new Date(agent.updatedAt).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center mb-6 w-full max-w-xl mx-auto">
                <Button variant="ghost" size="icon" className="mr-2 text-gray-600 hover:bg-slate-100" onClick={() => { resetForm(); setViewMode('list'); }}>
                  <ArrowLeft size={20} />
                </Button>
                <h1 className="text-2xl font-semibold text-gray-700">{editingAgent ? 'EDIT AGENT' : 'CREATE AGENT'}</h1>
              </div>
              
              {/* <input type="file" id="fileUploadInput" multiple className="hidden" onChange={(e) => onDrop(Array.from(e.target.files || []))} /> Removed */}

              <div className="w-full max-w-2xl mx-auto pb-24 space-y-6">
                <div className="w-full">
                  <Label htmlFor="agentName" className="text-sm font-medium text-gray-700">
                    Name
                  </Label>
                  <Input
                    id="agentName"
                    placeholder="e.g., Report Generator"
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    className="mt-1 bg-white border border-gray-300 rounded-lg w-full text-base h-11 px-3" 
                  />
                </div>

                <div className="w-full">
                  <Label htmlFor="agentDescription" className="text-sm font-medium text-gray-700">
                    Description
                  </Label>
                  <Textarea 
                    id="agentDescription"
                    placeholder="e.g., Helps with generating quarterly financial reports..."
                    value={agentDescription}
                    onChange={(e) => setAgentDescription(e.target.value)}
                    className="mt-1 bg-white border border-gray-300 rounded-lg w-full h-24 p-3 text-base" 
                  />
                </div>

                <div className="w-full">
                  <Label htmlFor="agentPrompt" className="text-sm font-medium text-gray-700">
                    Prompt
                  </Label>
                  <Textarea
                    id="agentPrompt"
                    placeholder="e.g., You are a helpful assistant..."
                    value={agentPrompt}
                    onChange={(e) => setAgentPrompt(e.target.value)}
                    className="mt-1 bg-white border border-gray-300 rounded-lg w-full h-40 p-3 text-base" 
                  />
                </div>
                
                <div>
                  <Label className="text-base font-medium text-gray-800">App Integrations</Label>
                  <p className="text-xs text-gray-500 mt-1 mb-3">
                    Select knowledge sources for your agent.
                  </p>
                  <div className="flex flex-wrap items-center gap-2 p-3 border border-gray-300 rounded-lg min-h-[48px] bg-white">
                    {currentSelectedIntegrationObjects.length === 0 && (
                      <span className="text-gray-400 text-sm">Add integrations..</span>
                    )}
                    {currentSelectedIntegrationObjects.map((integration) => (
                      <CustomBadge
                        key={integration.id}
                        text={integration.name}
                        icon={integration.icon}
                        onRemove={() => handleRemoveSelectedIntegration(integration.id)}
                      />
                    ))}
                    <DropdownMenu open={isIntegrationMenuOpen} onOpenChange={setIsIntegrationMenuOpen}>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="ml-auto p-1 h-7 w-7 text-slate-500 hover:text-slate-700">
                          <PlusCircle size={20} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="w-72 md:w-80 max-h-80 overflow-y-auto" align="start">
                      <div className="flex items-center justify-between px-2 py-1.5">
                        <DropdownMenuLabel className="p-0 text-sm font-medium">Select Integrations</DropdownMenuLabel>
                        {currentSelectedIntegrationObjects.length > 0 && (
                           <Button variant="ghost" size="sm" onClick={handleClearAllIntegrations} className="p-1 h-auto text-xs text-slate-500 hover:text-slate-700">
                             <RotateCcw size={14} className="mr-1" /> Clear all
                           </Button>
                        )}
                      </div>
                      <DropdownMenuSeparator />
                      {availableIntegrationsList.map((integration) => (
                        <DropdownMenuItem
                          key={integration.id}
                          onSelect={(e) => e.preventDefault()} 
                          onClick={() => toggleIntegrationSelection(integration.id)}
                          className="flex items-center justify-between cursor-pointer text-sm py-2 px-2 hover:bg-slate-50"
                        >
                          <div className="flex items-center">
                            <span className="mr-2 flex items-center">{integration.icon}</span> {/* Removed h-4 w-4 */}
                            <span>{integration.name}</span>
                          </div>
                          {selectedIntegrations[integration.id] && <Check className="h-4 w-4 text-slate-700" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  </div> 
                </div>
                {/* Files & Folders and Allow Web Search sections removed */}
              </div>
            </>
          )}
           {viewMode !== 'list' && (
            <div className="absolute bottom-0 left-0 w-full p-4 md:p-8 bg-white border-t border-gray-200">
              <div className="flex justify-end w-full max-w-2xl mx-auto">
                  <Button 
                    onClick={handleSaveAgent}
                    className="bg-slate-800 hover:bg-slate-700 text-white rounded-lg px-6 py-2.5 text-sm font-medium"
                  >
                    {editingAgent ? 'Save Changes' : 'Create Agent'}
                  </Button>
              </div>
            </div>
           )}
        </div>

        {viewMode !== 'list' && (
          <div className="w-full md:w-[50%] bg-gray-50 flex flex-col h-full">
            <div className="p-4 md:px-8 md:py-6 border-b border-gray-200 flex justify-between items-center">
              <h2 className="text-lg font-semibold text-gray-700">TEST AGENT</h2>
              {agents.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="ml-auto text-xs h-8">
                    {selectedChatAgentExternalId 
                      ? agents.find(a => a.externalId === selectedChatAgentExternalId)?.name || "Select Agent to Test" 
                      : "Test Current Form Config"}
                    <ChevronDown className="ml-2 h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuItem onSelect={() => setSelectedChatAgentExternalId(null)}>
                    Test Current Form Config
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Or select a saved agent</DropdownMenuLabel>
                  {agents.map(agent => (
                    <DropdownMenuItem key={agent.externalId} onSelect={() => setSelectedChatAgentExternalId(agent.externalId)}>
                      {agent.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            </div>
          
            <div
              className="flex flex-col flex-grow overflow-y-auto p-4 md:p-6 space-y-4"
              ref={messagesContainerRef}
              onScroll={handleScroll}
            >
              {messages.map((message, index) => (
              <AgentChatMessage
                key={message.externalId ?? index}
                message={message.message}
                isUser={message.messageRole === "user"}
                thinking={message.thinking}
                citations={message.sources}
                messageId={message.externalId}
                handleRetry={handleRetry}
                citationMap={message.citationMap}
                dots={isStreaming && index === messages.length -1 && message.messageRole === 'assistant' ? dots : ""} // Corrected dots logic
                isStreaming={isStreaming && index === messages.length -1 && message.messageRole === 'assistant'}
              />
            ))}
            {currentResp && (
              <AgentChatMessage
                message={currentResp.resp}
                citations={currentResp.sources}
                thinking={currentResp.thinking || ""}
                isUser={false}
                handleRetry={handleRetry}
                dots={dots}
                messageId={currentResp.messageId}
                citationMap={currentResp.citationMap}
                isStreaming={isStreaming}
              />
            )}
            </div>
          
            <div className="p-2 md:p-4 border-t border-gray-200 bg-gray-50 flex justify-center">
              <ChatBox 
              query={query}
              setQuery={setQuery}
              handleSend={handleSend}
              handleStop={handleStop}
              isStreaming={isStreaming}
              allCitations={allCitations} 
              isReasoningActive={isReasoningActive}
              setIsReasoningActive={setIsReasoningActive}
              // agentIdForDisplay is no longer passed; ChatBox reads from URL
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const textToCitationIndexPattern = /\[(\d+)\]/g;

const renderMarkdownLink = ({ node, ...linkProps }: { node?: any; [key: string]: any }) => (
  <a {...linkProps} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline" />
);

const AgentChatMessage = ({
  message,
  thinking,
  isUser,
  isRetrying, // Added isRetrying back as it was in original and used for dots
  citations = [],
  messageId,
  handleRetry,
  dots = "",
  citationMap,
  isStreaming = false,
}: {
  message: string;
  thinking?: string;
  isUser: boolean;
  isRetrying?: boolean; // Added isRetrying back
  citations?: Citation[];
  messageId?: string;
  dots?: string;
  handleRetry: (messageId: string) => void;
  citationMap?: Record<number, number>;
  isStreaming?: boolean;
}) => {
  const [isCopied, setIsCopied] = useState(false);
  const { toast } = useToast(); 
  const citationUrls = citations?.map((c: Citation) => c.url);

  const processMessage = (text: string) => {
    if(!text) return "";
    text = splitGroupedCitationsWithSpaces(text);

    if (citationMap) {
      return text.replace(textToCitationIndexPattern, (match, num) => {
        const index = citationMap[num];
        const url = citationUrls[index];
        return typeof index === "number" && url
          ? `[[${index + 1}]](${url})`
          : "";
      });
    } else {
      return text.replace(textToCitationIndexPattern, (match, num) => {
        const url = citationUrls[num - 1];
        return url ? `[[${num}]](${url})` : "";
      });
    }
  };
  
  const rawTextForCopy = (text: string) => {
    if (!text) return "";
    text = splitGroupedCitationsWithSpaces(text);
    return text.replace(textToCitationIndexPattern, (match, num) => `[${num}]`);
  };

  return (
    <div
      className={`rounded-[16px] ${
        isUser
          ? "bg-[#F0F2F4] text-[#1C1D1F] text-[15px] leading-[25px] self-end pt-[14px] pb-[14px] pl-[20px] pr-[20px]"
          : "text-[#1C1D1F] text-[15px] leading-[25px] self-start"
      }`}
    >
      {isUser ? (
        <div dangerouslySetInnerHTML={{ __html: message }} />
      ) : (
        <div
          className={`flex flex-col mt-[40px] ${citationUrls && citationUrls.length ? "mb-[35px]" : ""}`}
        >
          <div className="flex flex-row">
            <img
              className={"mr-[20px] w-[32px] self-start"}
              src={AssistantLogo}
              alt="Agent"
            />
            <div className="mt-[4px] markdown-content w-full">
              {thinking && (
                <div className="border-l-2 border-[#E6EBF5] pl-2 mb-4 text-gray-600">
                  <MarkdownPreview
                    source={processMessage(thinking)}
                    wrapperElement={{
                      "data-color-mode": "light",
                    }}
                    style={{
                      padding: 0,
                      backgroundColor: "transparent",
                      color: "#627384",
                      fontSize: '15px',
                    }}
                    components={{
                      a: renderMarkdownLink,
                    }}
                  />
                </div>
              )}
              {message === "" && !thinking && isStreaming ? (
                <div className="flex-grow text-[#1C1D1F]">
                  {isRetrying ? `Retrying${dots}` : `Thinking${dots}`}
                </div>
              ) : (
                <MarkdownPreview
                  source={processMessage(message)}
                  wrapperElement={{
                    "data-color-mode": "light",
                  }}
                  style={{
                    padding: 0,
                    backgroundColor: "transparent",
                    color: "#1C1D1F", 
                    fontSize: '15px',
                  }}
                  components={{
                    a: renderMarkdownLink,
                    table: ({ node, ...props }) => (
                      <div className="overflow-x-auto w-[720px] my-2">
                        <table
                          style={{
                            borderCollapse: "collapse",
                            borderStyle: "hidden",
                            tableLayout: "fixed",
                            width: "100%",
                          }}
                          className="min-w-full"
                          {...props}
                        />
                      </div>
                    ),
                    th: ({ node, ...props }) => (
                      <th
                        style={{
                          border: "none",
                          padding: "4px 8px",
                          textAlign: "left",
                          overflowWrap: "break-word",
                        }}
                        {...props}
                      />
                    ),
                    td: ({ node, ...props }) => (
                      <td
                        style={{
                          border: "none",
                          borderTop: "1px solid #e5e7eb",
                          padding: "4px 8px",
                          overflowWrap: "break-word",
                        }}
                        {...props}
                      />
                    ),
                    tr: ({ node, ...props }) => (
                      <tr
                        style={{ backgroundColor: "#ffffff", border: "none" }}
                        {...props}
                      />
                    ),
                    h1: ({ node, ...props }) => (<h1 style={{ fontSize: "1.6em", fontWeight: '600', margin: '0.67em 0' }} {...props} />),
                    h2: ({ node, ...props }) => (<h2 style={{ fontSize: "1.3em", fontWeight: '600', margin: '0.83em 0' }} {...props} />),
                    h3: ({ node, ...props }) => (<h3 style={{ fontSize: "1.1em", fontWeight: '600', margin: '1em 0' }} {...props} />),
                  }}
                />
              )}
            </div>
          </div>
          {!isStreaming && messageId && (
            <div className="flex flex-col">
              <div className="flex ml-[52px] mt-[12px] items-center">
                <Copy
                  size={16}
                  stroke={`${isCopied ? "#4F535C" : "#B2C3D4"}`}
                  className={`cursor-pointer`}
                  onMouseDown={() => setIsCopied(true)}
                  onMouseUp={() => setTimeout(() => setIsCopied(false), 200)}
                  onClick={() => {
                    navigator.clipboard.writeText(rawTextForCopy(message));
                    toast({ description: "Copied to clipboard!", duration: 1500 });
                  }}
                />
                <img
                  className={`ml-[18px] ${isStreaming ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                  src={RetryAsset}
                  onClick={() => !isStreaming && handleRetry(messageId!)}
                  alt="Retry"
                />
              </div>

              {citations && citations.length > 0 && (
                <div className="flex flex-row ml-[52px]">
                  <TooltipProvider>
                    <ul className={`flex flex-row mt-[24px]`}>
                      {citations.slice(0, 3).map((citation: Citation, index: number) => (
                        <li
                          key={index}
                          className="border-[#E6EBF5] border-[1px] rounded-[10px] w-[196px] mr-[6px]"
                        >
                          <a
                            href={citation.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={citation.title}
                            className="block hover:bg-slate-50 transition-colors duration-150"
                          >
                            <div className="flex pl-[12px] pt-[10px] pr-[12px]">
                              <div className="flex flex-col w-full">
                                <p className="line-clamp-2 text-[13px] tracking-[0.01em] leading-[17px] text-ellipsis font-medium text-[#1C1D1F]">
                                  {citation.title}
                                </p>
                                <div className="flex flex-col mt-[9px]">
                                  <div className="flex items-center pb-[12px]">
                                    {getIcon(citation.app, citation.entity, {w:14, h:14, mr: 8})}
                                    <span
                                      style={{ fontWeight: 450 }}
                                      className="text-[#848DA1] text-[13px] tracking-[0.01em] leading-[16px] ml-1.5"
                                    >
                                      {getName(citation.app, citation.entity)}
                                    </span>
                                    <span
                                      className="flex ml-auto items-center p-[5px] h-[16px] bg-[#EBEEF5] mt-[3px] rounded-full text-[9px] text-[#4A4F59]"
                                      style={{ fontFamily: "JetBrains Mono" }}
                                    >
                                      {index + 1}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </TooltipProvider>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
