
import { createFileRoute, useRouterState, useNavigate } from "@tanstack/react-router";
import { ChatPageProps } from "./chat";
import { errorComponent } from "@/components/error";
import { Sidebar } from "@/components/Sidebar";
import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  Search,
  Plus,
  Star,
  Users,
  ChevronDown,
  X as LucideX,
  Check,
  RotateCcw,
  PlusCircle,
  ArrowLeft,
  Copy,
  // Edit3, // Kept for potential future use on cards
  // Trash2, // Kept for potential future use on cards
  UserPlus as UserPlusIcon, 
} from "lucide-react";
import { Card, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { getIcon } from "@/lib/common";
import { getName } from "@/components/GroupFilter";
import {
  Apps,
  DriveEntity,
  SelectPublicAgent,
  SelectPublicMessage, // For Test Agent Panel
  Citation,            // For Test Agent Panel
  ChatSSEvents,        // For Test Agent Panel
} from "shared/types";
import { api } from "@/api";
import { useToast } from "@/hooks/use-toast";
import MarkdownPreview from "@uiw/react-markdown-preview"; // For Test Agent Panel
import AssistantLogo from "@/assets/assistant-logo.svg";   // For Test Agent Panel
import RetryAsset from "@/assets/retry.svg";              // For Test Agent Panel
import { splitGroupedCitationsWithSpaces } from "@/lib/utils"; // For Test Agent Panel
import { TooltipProvider } from "@/components/ui/tooltip"; // For Test Agent Panel (citations)
import { ChatBox } from "@/components/ChatBox";             // For Test Agent Panel
import { useTheme } from "@/components/ThemeContext";       // For Test Agent Panel (MarkdownPreview, AgentChatMessage)

import type { Agent, AgentsState } from "../../types"; 
import sharedAgentsDataJson from "../../data/shared-agents.json"; 
import personalAgentsDataJson from "../../data/personal-agents.json"; 
import favoriteAgentsData from "../../data/favourite-agents.json"; 

// --- Types and Components for Form & Test Panel (inspired by agent.tsx) ---
interface CustomBadgeProps {
  text: string
  onRemove: () => void
  icon?: React.ReactNode
}

const CustomBadge: React.FC<CustomBadgeProps> = ({ text, onRemove, icon }) => {
  return (
    <div className="flex items-center justify-center bg-slate-100 dark:bg-slate-600 text-slate-700 dark:text-slate-200 text-xs font-medium pl-2 pr-1 py-1 rounded-md border border-slate-200 dark:border-slate-500">
      {icon && <span className="mr-1 flex items-center">{icon}</span>}
      <span>{text}</span>
      <LucideX
        className="ml-1.5 h-3.5 w-3.5 cursor-pointer hover:text-red-500 dark:hover:text-red-400"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
      />
    </div>
  )
}

interface FetchedDataSource { docId: string; name: string; }
interface FormIntegrationSource { id: string; name: string; app: Apps | string; entity: string; icon: React.ReactNode; }
interface FormUser { id: number; name: string; email: string; }

const availableIntegrationsList: FormIntegrationSource[] = [
  { id: "googledrive", name: "Google Drive", app: Apps.GoogleDrive, entity: "file", icon: getIcon(Apps.GoogleDrive, "file", { w: 16, h: 16, mr: 8 }) },
  { id: "googledocs", name: "Google Docs", app: Apps.GoogleDrive, entity: DriveEntity.Docs, icon: getIcon(Apps.GoogleDrive, DriveEntity.Docs, { w: 16, h: 16, mr: 8 }) },
  { id: "googlesheets", name: "Google Sheets", app: Apps.GoogleDrive, entity: DriveEntity.Sheets, icon: getIcon(Apps.GoogleDrive, DriveEntity.Sheets, { w: 16, h: 16, mr: 8 }) },
  { id: "slack", name: "Slack", app: Apps.Slack, entity: "message", icon: getIcon(Apps.Slack, "message", { w: 16, h: 16, mr: 8 }) },
  { id: "gmail", name: "Gmail", app: Apps.Gmail, entity: "mail", icon: getIcon(Apps.Gmail, "mail", { w: 16, h: 16, mr: 8 }) },
  { id: "googlecalendar", name: "Calendar", app: Apps.GoogleCalendar, entity: "event", icon: getIcon(Apps.GoogleCalendar, "event", { w: 16, h: 16, mr: 8 }) },
  { id: "pdf", name: "PDF", app: "pdf", entity: "pdf_default", icon: getIcon("pdf", "pdf_default", { w: 16, h: 16, mr: 8 }) },
];

type CurrentResp = { resp: string; chatId?: string; messageId?: string; sources?: Citation[]; citationMap?: Record<number, number>; thinking?: string; }
const REASONING_STATE_KEY_DIR = "isAgentReasoningDirectoryState"; // Unique key for this instance

// --- AgentChatMessage (copied from agent.tsx) ---
const textToCitationIndexPattern = /\[(\d+)\]/g
const renderMarkdownLink = ({ node, ...linkProps }: { node?: any; [key: string]: any }) => (
  <a {...linkProps} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline" />
)
const AgentChatMessage = ({ message, thinking, isUser, citations = [], messageId, handleRetry, dots = "", citationMap, isStreaming = false, }: { message: string; thinking?: string; isUser: boolean; citations?: Citation[]; messageId?: string; dots?: string; handleRetry: (messageId: string) => void; citationMap?: Record<number, number>; isStreaming?: boolean; }) => {
  const { theme } = useTheme();
  const [isCopied, setIsCopied] = useState(false);
  const { toast } = useToast();
  const citationUrls = citations?.map((c: Citation) => c.url);

  const processMessage = (text: string) => {
    if (!text) return "";
    text = splitGroupedCitationsWithSpaces(text);
    if (citationMap) {
      return text.replace(textToCitationIndexPattern, (match, num) => {
        const index = citationMap[num];
        const url = citationUrls[index];
        return typeof index === "number" && url ? `[[${index + 1}]](${url})` : "";
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
    <div className={`rounded-[16px] max-w-full ${isUser ? "bg-[#F0F2F4] dark:bg-slate-700 text-[#1C1D1F] dark:text-slate-100 text-[15px] leading-[25px] self-end pt-[14px] pb-[14px] pl-[20px] pr-[20px] break-words" : "text-[#1C1D1F] dark:text-[#F1F3F4] text-[15px] leading-[25px] self-start w-full"}`}>
      {isUser ? (
        <div className="break-words overflow-wrap-anywhere" dangerouslySetInnerHTML={{ __html: message }} />
      ) : (
        <div className={`flex flex-col mt-[40px] w-full ${citationUrls && citationUrls.length ? "mb-[35px]" : ""}`}>
          <div className="flex flex-row w-full">
            <img className={"mr-[20px] w-[32px] self-start flex-shrink-0"} src={AssistantLogo} alt="Agent" />
            <div className="mt-[4px] markdown-content w-full">
              {thinking && (
                <div className="border-l-2 border-[#E6EBF5] dark:border-gray-700 pl-2 mb-4 text-gray-600 dark:text-gray-400">
                  <MarkdownPreview source={processMessage(thinking)} wrapperElement={{ "data-color-mode": theme }} style={{ padding: 0, backgroundColor: "transparent", color: theme === "dark" ? "#A0AEC0" : "#627384", fontSize: "15px", maxWidth: "100%", overflowWrap: "break-word" }} components={{ a: renderMarkdownLink }} />
                </div>
              )}
              {message === "" && !thinking && isStreaming ? (
                <div className="flex-grow text-[#1C1D1F] dark:text-[#F1F3F4]">{`Thinking${dots}`}</div>
              ) : (
                <MarkdownPreview source={processMessage(message)} wrapperElement={{ "data-color-mode": theme }} style={{ padding: 0, backgroundColor: "transparent", color: theme === "dark" ? "#F1F3F4" : "#1C1D1F", fontSize: "15px", maxWidth: "100%", overflowWrap: "break-word" }} components={{ a: renderMarkdownLink, table: ({ node, ...props }) => (<div className="overflow-x-auto w-full my-2"><table style={{ borderCollapse: "collapse", borderStyle: "hidden", tableLayout: "auto", width: "100%" }} className="min-w-full dark:bg-slate-800" {...props} /></div>), th: ({ node, ...props }) => (<th style={{ border: "none", padding: "4px 8px", textAlign: "left", overflowWrap: "break-word" }} className="dark:text-gray-200" {...props} />), td: ({ node, ...props }) => (<td style={{ border: "none", borderTop: "1px solid #e5e7eb", padding: "4px 8px", overflowWrap: "break-word" }} className="dark:border-gray-700 dark:text-gray-300" {...props} />), tr: ({ node, ...props }) => (<tr style={{ backgroundColor: "#ffffff", border: "none" }} className="dark:bg-slate-800" {...props} />), h1: ({ node, ...props }) => (<h1 style={{ fontSize: "1.6em", fontWeight: "600", margin: "0.67em 0" }} className="dark:text-gray-100" {...props} />), h2: ({ node, ...props }) => (<h2 style={{ fontSize: "1.3em", fontWeight: "600", margin: "0.83em 0" }} className="dark:text-gray-100" {...props} />), h3: ({ node, ...props }) => (<h3 style={{ fontSize: "1.1em", fontWeight: "600", margin: "1em 0" }} className="dark:text-gray-100" {...props} />), }} />
              )}
            </div>
          </div>
          {!isStreaming && messageId && (
            <div className="flex flex-col">
              <div className="flex ml-[52px] mt-[12px] items-center">
                <Copy size={16} stroke={`${isCopied ? (theme === "dark" ? "#A0AEC0" : "#4F535C") : theme === "dark" ? "#6B7280" : "#B2C3D4"}`} className={`cursor-pointer`} onMouseDown={() => setIsCopied(true)} onMouseUp={() => setTimeout(() => setIsCopied(false), 200)} onClick={() => { navigator.clipboard.writeText(rawTextForCopy(message)); toast({ description: "Copied to clipboard!", duration: 1500 }); }} />
                <img className={`ml-[18px] ${isStreaming ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`} src={RetryAsset} onClick={() => !isStreaming && handleRetry(messageId!)} alt="Retry" />
              </div>
              {citations && citations.length > 0 && (
                <div className="flex flex-row ml-[52px]">
                  <TooltipProvider>
                    <ul className={`flex flex-row mt-[24px]`}>
                      {citations.slice(0, 3).map((citation: Citation, index: number) => (
                        <li key={index} className="border-[#E6EBF5] dark:border-gray-700 border-[1px] rounded-[10px] w-[196px] mr-[6px]">
                          <a href={citation.url} target="_blank" rel="noopener noreferrer" title={citation.title} className="block hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors duration-150">
                            <div className="flex pl-[12px] pt-[10px] pr-[12px]">
                              <div className="flex flex-col w-full">
                                <p className="line-clamp-2 text-[13px] tracking-[0.01em] leading-[17px] text-ellipsis font-medium text-[#1C1D1F] dark:text-gray-100">{citation.title}</p>
                                <div className="flex flex-col mt-[9px]">
                                  <div className="flex items-center pb-[12px]">
                                    {getIcon(citation.app, citation.entity, { w: 14, h: 14, mr: 8 })}
                                    <span style={{ fontWeight: 450 }} className="text-[#848DA1] dark:text-gray-400 text-[13px] tracking-[0.01em] leading-[16px] ml-1.5">{getName(citation.app, citation.entity)}</span>
                                    <span className="flex ml-auto items-center p-[5px] h-[16px] bg-[#EBEEF5] dark:bg-slate-700 dark:text-gray-300 mt-[3px] rounded-full text-[9px] text-[#4A4F59]" style={{ fontFamily: "JetBrains Mono" }}>{index + 1}</span>
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
  )
}


// Data loading for directory view
const sharedAgentsDataSource: Agent[] = sharedAgentsDataJson as Agent[];
const personalAgentsDataSource: Agent[] = personalAgentsDataJson as Agent[];

export const Route = createFileRoute("/_authenticated/agentDirectory")({
  component: AgentDirectoryPage,
  errorComponent: errorComponent,
});

function AgentDirectoryPage() {
  const matches = useRouterState({ select: (s) => s.matches });
  const { user, workspace, agentWhiteList } = matches[matches.length - 1].context as ChatPageProps & { agentWhiteList: boolean };
  const { toast: showToast } = useToast();
  // const navigate = useNavigate(); // Not currently used after form submission, but available

  // --- Directory View State ---
  const [directoryState, setDirectoryState] = useState<AgentsState>({
    sharedAgents: sharedAgentsDataSource, // Consider fetching these dynamically if they change
    personalAgents: personalAgentsDataSource, // Same as above
    favoriteAgents: favoriteAgentsData,
    searchQuery: "",
    activeTab: "all",
  });
  const [agentsForTestPanel, setAgentsForTestPanel] = useState<SelectPublicAgent[]>([]); // For dropdown in test panel

  // --- Form & Test Panel Shared State ---
  const [showCreateEditForm, setShowCreateEditForm] = useState(false);
  const [editingAgent, setEditingAgent] = useState<SelectPublicAgent | null>(null);
  
  // Form specific state
  const [agentName, setAgentName] = useState("");
  const [agentDescription, setAgentDescription] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [selectedModel, setSelectedModel] = useState("Auto");
  const [fetchedDataSources, setFetchedDataSources] = useState<FetchedDataSource[]>([]);
  const [selectedIntegrations, setSelectedIntegrations] = useState<Record<string, boolean>>({});
  const [isIntegrationMenuOpen, setIsIntegrationMenuOpen] = useState(false);
  const [formUsers, setFormUsers] = useState<FormUser[]>([]);
  const [formUserSearchQuery, setFormUserSearchQuery] = useState("");
  const [formFilteredUsers, setFormFilteredUsers] = useState<FormUser[]>([]);
  const [formSelectedUsers, setFormSelectedUsers] = useState<FormUser[]>([]);
  const [formShowUserSearchResults, setFormShowUserSearchResults] = useState(false);
  const [formSelectedUserSearchIndex, setFormSelectedUserSearchIndex] = useState(-1);
  const formUserSearchResultsRef = useRef<HTMLDivElement>(null);

  // Test Panel specific state
  const [testPanelQuery, setTestPanelQuery] = useState("");
  const [testPanelMessages, setTestPanelMessages] = useState<SelectPublicMessage[]>([]);
  const [testPanelChatId, setTestPanelChatId] = useState<string | null>(null);
  const [testPanelCurrentResp, setTestPanelCurrentResp] = useState<CurrentResp | null>(null);
  const testPanelCurrentRespRef = useRef<CurrentResp | null>(null);
  const testPanelEventSourceRef = useRef<EventSource | null>(null);
  const [testPanelIsStreaming, setTestPanelIsStreaming] = useState(false);
  const [testPanelUserStopped, setTestPanelUserStopped] = useState<boolean>(false);
  const [testPanelDots, setTestPanelDots] = useState("");
  const testPanelMessagesContainerRef = useRef<HTMLDivElement>(null);
  const [testPanelUserHasScrolled, setTestPanelUserHasScrolled] = useState(false);
  const [testPanelSelectedChatAgentExternalId, setTestPanelSelectedChatAgentExternalId] = useState<string | null>(null);
  const [isTestPanelReasoningActive, setIsTestPanelReasoningActive] = useState(() => {
    const storedValue = localStorage.getItem(REASONING_STATE_KEY_DIR);
    return storedValue ? JSON.parse(storedValue) : false;
  });
   useEffect(() => {
    localStorage.setItem(REASONING_STATE_KEY_DIR, JSON.stringify(isTestPanelReasoningActive));
  }, [isTestPanelReasoningActive]);


  // --- Directory Logic ---
  const fetchDirectoryAgents = async () => { // Function to refresh directory agents
    try {
      // This is a placeholder. Replace with actual API calls if agents are fetched from backend.
      // For now, it just resets to initial JSON data.
      // const response = await api.agents.$get(); // Example if you have an endpoint
      // if (response.ok) {
      //   const allAgentsData = await response.json() as SelectPublicAgent[];
      //   setDirectoryState(prev => ({...prev, sharedAgents: allAgentsData, personalAgents: []})); // Adjust based on your data structure
      //   setAgentsForTestPanel(allAgentsData);
      // } else {
      //   showToast({ title: "Error", description: "Failed to refresh agents.", variant: "destructive" });
      // }
      const allDirectoryAgents = [...sharedAgentsDataSource, ...personalAgentsDataSource] as SelectPublicAgent[];
      setAgentsForTestPanel(allDirectoryAgents); // For test panel dropdown
    } catch (error) {
      showToast({ title: "Error", description: "An error occurred while refreshing agents.", variant: "destructive" });
    }
  };

  useEffect(() => {
    fetchDirectoryAgents(); // Load agents for test panel dropdown on initial mount
  }, []);


  const getFilteredAgents = (): Agent[] => {
    let agentsToFilter: Agent[] = [];
    if (directoryState.activeTab === "all") agentsToFilter = [...directoryState.sharedAgents, ...directoryState.personalAgents];
    else if (directoryState.activeTab === "shared-to-me") agentsToFilter = [...directoryState.sharedAgents];
    else if (directoryState.activeTab === "made-by-me") agentsToFilter = [...directoryState.personalAgents];
    if (directoryState.searchQuery) {
      const query = directoryState.searchQuery.toLowerCase();
      agentsToFilter = agentsToFilter.filter(a => a.name.toLowerCase().includes(query) || a.description.toLowerCase().includes(query));
    }
    return agentsToFilter;
  };
  const getFavoriteAgents = (): Agent[] => ([...directoryState.sharedAgents, ...directoryState.personalAgents]).filter(a => directoryState.favoriteAgents.includes(a.id));
  const toggleFavorite = (agentId: string) => setDirectoryState(prev => ({ ...prev, favoriteAgents: prev.favoriteAgents.includes(agentId) ? prev.favoriteAgents.filter(id => id !== agentId) : [...prev.favoriteAgents, agentId] }));
  const handleDirectorySearchChange = (e: React.ChangeEvent<HTMLInputElement>) => setDirectoryState(prev => ({ ...prev, searchQuery: e.target.value }));
  const handleTabChange = (tab: "all" | "shared-to-me" | "made-by-me") => setDirectoryState(prev => ({ ...prev, activeTab: tab }));

  // --- Form Logic ---
  const resetForm = () => {
    setAgentName(""); setAgentDescription(""); setAgentPrompt(""); setSelectedModel("Auto");
    setSelectedIntegrations({}); setEditingAgent(null); setFormSelectedUsers([]);
    setFormUserSearchQuery(""); setFormShowUserSearchResults(false); setFormSelectedUserSearchIndex(-1);
  };
  const handleShowCreateAgentForm = () => { resetForm(); setShowCreateEditForm(true); };
  const handleCancelForm = () => { setShowCreateEditForm(false); resetForm(); };
  const allAvailableFormIntegrations = useMemo(() => {
    const dynamicDataSources: FormIntegrationSource[] = fetchedDataSources.map(ds => ({ id: ds.docId, name: ds.name, app: Apps.DataSource, entity: "datasource", icon: getIcon(Apps.DataSource, "datasource", { w: 16, h: 16, mr: 8 }) }));
    return [...availableIntegrationsList, ...dynamicDataSources];
  }, [fetchedDataSources]);

  useEffect(() => {
    const fetchDataSourcesAsync = async () => {
      if (showCreateEditForm) {
        try {
          const response = await api.datasources.$get();
          if (response.ok) setFetchedDataSources(await response.json() as FetchedDataSource[]);
          else { showToast({ title: "Error", description: "Failed to fetch data sources.", variant: "destructive" }); setFetchedDataSources([]); }
        } catch (error) { showToast({ title: "Error", description: "An error occurred fetching data sources.", variant: "destructive" }); setFetchedDataSources([]); }
      }
    };
    fetchDataSourcesAsync();
  }, [showCreateEditForm, showToast]);

  useEffect(() => {
    const loadFormUsers = async () => { if (showCreateEditForm) setFormUsers([]); }; // Placeholder for actual user fetching
    loadFormUsers();
  }, [showCreateEditForm]);

  useEffect(() => {
    if (editingAgent && showCreateEditForm) {
      setAgentName(editingAgent.name); setAgentDescription(editingAgent.description || "");
      setAgentPrompt(editingAgent.prompt || ""); setSelectedModel(editingAgent.model);
      const currentIntegrations: Record<string, boolean> = {};
      allAvailableFormIntegrations.forEach(int => { currentIntegrations[int.id] = editingAgent.appIntegrations?.includes(int.id) || false; });
      setSelectedIntegrations(currentIntegrations);
      // setFormSelectedUsers(editingAgent.usersData || []); // If agent has associated user data
    }
  }, [editingAgent, showCreateEditForm, allAvailableFormIntegrations]);

  const handleSaveAgent = async () => {
    const enabledIntegrations = Object.entries(selectedIntegrations).filter(([, sel]) => sel).map(([id]) => id);
    const agentPayload = { name: agentName, description: agentDescription, prompt: agentPrompt, model: selectedModel, appIntegrations: enabledIntegrations };
    try {
      const response = editingAgent?.externalId
        ? await api.agent[":agentExternalId"].$put({ param: { agentExternalId: editingAgent.externalId }, json: agentPayload })
        : await api.agent.create.$post({ json: agentPayload });
      if (response.ok) {
        showToast({ title: "Success", description: `Agent ${editingAgent ? "updated" : "created"} successfully.` });
        setShowCreateEditForm(false); resetForm(); fetchDirectoryAgents(); // Refresh list
      } else {
        const errorData = await response.json();
        showToast({ title: "Error", description: `Failed to ${editingAgent ? "update" : "create"} agent: ${errorData.message || response.statusText}`, variant: "destructive" });
      }
    } catch (error) { showToast({ title: "Error", description: `An error occurred.`, variant: "destructive" }); }
  };
  
  const toggleIntegrationSelection = (id: string) => setSelectedIntegrations(prev => ({ ...prev, [id]: !prev[id] }));
  const handleRemoveSelectedIntegration = (id: string) => setSelectedIntegrations(prev => ({ ...prev, [id]: false }));
  const handleClearAllIntegrations = () => setSelectedIntegrations(allAvailableFormIntegrations.reduce((acc, int) => ({ ...acc, [int.id]: false }), {}));
  const currentSelectedIntegrationObjects = useMemo(() => allAvailableFormIntegrations.filter(int => selectedIntegrations[int.id]), [selectedIntegrations, allAvailableFormIntegrations]);

  useEffect(() => { setFormSelectedUserSearchIndex(-1); }, [formUserSearchQuery]);
  useEffect(() => {
    if (formSelectedUserSearchIndex < 0 || !formUserSearchResultsRef.current) return;
    const el = formUserSearchResultsRef.current.children[formSelectedUserSearchIndex] as HTMLElement;
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [formSelectedUserSearchIndex]);
  const handleFormUserKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (formFilteredUsers.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setFormSelectedUserSearchIndex(p => (p >= formFilteredUsers.length - 1 ? 0 : p + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFormSelectedUserSearchIndex(p => (p <= 0 ? formFilteredUsers.length - 1 : p - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (formSelectedUserSearchIndex >= 0) handleSelectFormUser(formFilteredUsers[formSelectedUserSearchIndex]); else if (formFilteredUsers.length > 0) handleSelectFormUser(formFilteredUsers[0]); }
  };
  useEffect(() => {
    if (formUserSearchQuery.trim() === "") { setFormFilteredUsers([]); setFormShowUserSearchResults(false); return; }
    const filtered = formUsers.filter(u => !formSelectedUsers.some(sel => sel.id === u.id) && (u.name.toLowerCase().includes(formUserSearchQuery.toLowerCase()) || u.email.toLowerCase().includes(formUserSearchQuery.toLowerCase())));
    setFormFilteredUsers(filtered); setFormShowUserSearchResults(true);
  }, [formUserSearchQuery, formUsers, formSelectedUsers]);
  const handleSelectFormUser = (u: FormUser) => { setFormSelectedUsers(prev => [...prev, u]); setFormUserSearchQuery(""); setFormShowUserSearchResults(false); };
  const handleRemoveFormUser = (userId: number) => setFormSelectedUsers(prev => prev.filter(u => u.id !== userId));

  // --- Test Panel Logic (copied and adapted from agent.tsx) ---
  useEffect(() => {
    if (testPanelIsStreaming) {
      const interval = setInterval(() => setTestPanelDots(prev => (prev.length >= 3 ? "" : prev + ".")), 500);
      return () => clearInterval(interval);
    } else setTestPanelDots("");
  }, [testPanelIsStreaming]);

  const handleTestPanelSend = async (messageToSend: string) => {
    if (!messageToSend || testPanelIsStreaming) return;
    setTestPanelUserHasScrolled(false); setTestPanelQuery("");
    setTestPanelMessages(prev => [...prev, { messageRole: "user", message: messageToSend, externalId: `user-${Date.now()}` }]);
    setTestPanelIsStreaming(true);
    setTestPanelCurrentResp({ resp: "", thinking: "" });
    testPanelCurrentRespRef.current = { resp: "", sources: [], thinking: "" };

    const url = new URL(`/api/v1/message/create`, window.location.origin);
    let chatConfigAgent: SelectPublicAgent | null | undefined = null;
    if (testPanelSelectedChatAgentExternalId) {
      chatConfigAgent = agentsForTestPanel.find(a => a.externalId === testPanelSelectedChatAgentExternalId);
    }

    const agentPromptPayload = {
      prompt: chatConfigAgent?.prompt || agentPrompt, // Use form prompt if no agent selected for test
      sources: allAvailableFormIntegrations.filter(int => chatConfigAgent ? chatConfigAgent.appIntegrations?.includes(int.id) : selectedIntegrations[int.id]).map(int => int.name),
    };
    url.searchParams.append("modelId", (chatConfigAgent?.model || selectedModel) === "Auto" ? "gpt-4o-mini" : (chatConfigAgent?.model || selectedModel));
    url.searchParams.append("message", encodeURIComponent(messageToSend));
    if (isTestPanelReasoningActive) url.searchParams.append("isReasoningEnabled", "true");
    url.searchParams.append("agentPrompt", JSON.stringify(agentPromptPayload));

    testPanelEventSourceRef.current = new EventSource(url.toString(), { withCredentials: true });
    const es = testPanelEventSourceRef.current;

    es.addEventListener(ChatSSEvents.CitationsUpdate, e => { const { contextChunks, citationMap } = JSON.parse(e.data); if (testPanelCurrentRespRef.current) { testPanelCurrentRespRef.current.sources = contextChunks; testPanelCurrentRespRef.current.citationMap = citationMap; setTestPanelCurrentResp(p => ({ ...(p || { resp: "", thinking: "" }), sources: contextChunks, citationMap })); } });
    es.addEventListener(ChatSSEvents.Reasoning, e => setTestPanelCurrentResp(p => ({ ...(p || { resp: "", thinking: e.data || "" }), thinking: (p?.thinking || "") + e.data })));
    es.addEventListener(ChatSSEvents.ResponseUpdate, e => setTestPanelCurrentResp(p => { const u = p ? { ...p, resp: p.resp + e.data } : { resp: e.data, thinking: "", sources: [], citationMap: {} }; testPanelCurrentRespRef.current = u; return u; }));
    es.addEventListener(ChatSSEvents.ResponseMetadata, e => { const { chatId: newChatId, messageId } = JSON.parse(e.data); if (newChatId && !testPanelChatId) setTestPanelChatId(newChatId); if (messageId && testPanelCurrentRespRef.current) setTestPanelCurrentResp(r => { const u = r || { resp: "", thinking: "" }; u.chatId = newChatId; u.messageId = messageId; testPanelCurrentRespRef.current = u; return u; }); });
    
    es.addEventListener(ChatSSEvents.End, () => { 
      if (testPanelCurrentRespRef.current) {
        setTestPanelMessages(p => [...p, { 
          messageRole: "assistant", 
          message: testPanelCurrentRespRef.current!.resp, 
          externalId: testPanelCurrentRespRef.current!.messageId, 
          sources: testPanelCurrentRespRef.current!.sources, 
          citationMap: testPanelCurrentRespRef.current!.citationMap, 
          thinking: testPanelCurrentRespRef.current!.thinking 
        }]);
      }
      setTestPanelCurrentResp(null); 
      testPanelCurrentRespRef.current = null; 
      es.close(); 
      testPanelEventSourceRef.current = null; 
      setTestPanelIsStreaming(false); 
      setTestPanelUserStopped(false); // Ensure userStopped is reset
    });

    es.addEventListener(ChatSSEvents.Error, e => { 
      console.error("SSE Error:", e.data); 
      const currentRespVal = testPanelCurrentRespRef.current;
      setTestPanelMessages(p => [...p, { 
        messageRole: "assistant", 
        message: `Error: ${e.data || "Unknown error"}`, 
        externalId: currentRespVal?.messageId || `err-${Date.now()}`,
        sources: currentRespVal?.sources,
        citationMap: currentRespVal?.citationMap,
        thinking: currentRespVal?.thinking,
      }]); 
      setTestPanelCurrentResp(null); 
      testPanelCurrentRespRef.current = null; 
      es.close(); 
      testPanelEventSourceRef.current = null; 
      setTestPanelIsStreaming(false); 
      setTestPanelUserStopped(false); // Ensure userStopped is reset
    });

    es.onerror = err => { 
      if (testPanelUserStopped) { 
        setTestPanelUserStopped(false); 
        // Clean up resources like in agent.tsx's onerror when userStopped is true
        setTestPanelCurrentResp(null);
        testPanelCurrentRespRef.current = null;
        if (testPanelEventSourceRef.current) {
            testPanelEventSourceRef.current.close();
            testPanelEventSourceRef.current = null;
        }
        setTestPanelIsStreaming(false);
        return; // Important: return early if user stopped
      } else { 
        console.error("SSE OnError:", err); 
        setTestPanelMessages(p => [...p, { 
          messageRole: "assistant", 
          message: "An error occurred while streaming the response. Please try again.", 
          externalId: `onerror-${Date.now()}` 
        }]); 
      } 
      setTestPanelCurrentResp(null); 
      testPanelCurrentRespRef.current = null; 
      if (testPanelEventSourceRef.current) { // Check if es (or testPanelEventSourceRef.current) is still valid before closing
          testPanelEventSourceRef.current.close();
          testPanelEventSourceRef.current = null;
      }
      setTestPanelIsStreaming(false); 
      setTestPanelUserStopped(false); // Ensure userStopped is reset
    };
    setTestPanelQuery("");
  };

  const handleTestPanelStop = async () => {
    setTestPanelUserStopped(true);
    if (testPanelEventSourceRef.current) { testPanelEventSourceRef.current.close(); testPanelEventSourceRef.current = null; }
    setTestPanelIsStreaming(false);
    if (testPanelChatId && testPanelCurrentRespRef.current?.messageId) { try { await api.chat.stop.$post({ json: { chatId: testPanelChatId } }); } catch (error) { console.error("Stop backend err:", error); } }
    if (testPanelCurrentRespRef.current?.resp) setTestPanelMessages(p => [...p, { messageRole: "assistant", message: testPanelCurrentRespRef.current!.resp || " ", externalId: testPanelCurrentRespRef.current!.messageId, sources: testPanelCurrentRespRef.current!.sources, citationMap: testPanelCurrentRespRef.current!.citationMap, thinking: testPanelCurrentRespRef.current!.thinking }]);
    setTestPanelCurrentResp(null); testPanelCurrentRespRef.current = null;
  };
  
  const handleTestPanelRetry = async (messageIdToRetry: string) => {
    const assistantMsgIdx = testPanelMessages.findIndex(msg => msg.externalId === messageIdToRetry && msg.messageRole === "assistant");
    if (assistantMsgIdx > 0) {
      const userMsg = testPanelMessages[assistantMsgIdx - 1];
      if (userMsg?.messageRole === "user") { setTestPanelMessages(prev => prev.slice(0, assistantMsgIdx - 1)); await handleTestPanelSend(userMsg.message); }
      else showToast({ title: "Retry Error", description: "Original user message not found.", variant: "destructive" });
    } else showToast({ title: "Retry Error", description: "Message to retry not found.", variant: "destructive" });
  };

  useEffect(() => {
    const container = testPanelMessagesContainerRef.current;
    if (!container || testPanelUserHasScrolled) return;
    container.scrollTop = container.scrollHeight;
  }, [testPanelMessages, testPanelCurrentResp?.resp]);
  const handleTestPanelScroll = () => { const c = testPanelMessagesContainerRef.current; if (c) setTestPanelUserHasScrolled(c.scrollHeight - c.scrollTop - c.clientHeight >= 100); };


  const favoriteAgentsList = getFavoriteAgents();
  const filteredAgentsList = getFilteredAgents();

  if (showCreateEditForm) {
    return (
      <div className="flex flex-col md:flex-row h-screen w-full bg-white dark:bg-[#1E1E1E]">
        <Sidebar photoLink={user?.photoLink} role={user?.role} isAgentMode={agentWhiteList} />
        <div className="flex flex-col md:flex-row flex-1 h-full md:ml-[60px]">
          {/* Left Column: Create/Edit Form */}
          <div className="w-full md:w-[50%] p-4 md:py-4 md:px-8 bg-white dark:bg-[#1E1E1E] overflow-y-auto h-full border-r border-gray-200 dark:border-gray-700">
            <div className="flex items-center mb-4 w-full max-w-xl mx-auto">
              <Button variant="ghost" size="icon" className="mr-2 text-gray-600 dark:text-gray-300 hover:bg-slate-100 dark:hover:bg-slate-700" onClick={handleCancelForm}>
                <ArrowLeft size={20} />
              </Button>
              <h1 className="text-2xl font-semibold text-gray-700 dark:text-gray-100">{editingAgent ? "EDIT AGENT" : "CREATE AGENT"}</h1>
            </div>
            <div className="w-full max-w-2xl mx-auto space-y-6 pb-8"> {/* Added pb-8 for spacing */}
              <div>
                <Label htmlFor="agentName" className="text-sm font-medium text-gray-700 dark:text-gray-300">Name</Label>
                <Input id="agentName" placeholder="e.g., Report Generator" value={agentName} onChange={(e) => setAgentName(e.target.value)} className="mt-1 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-lg w-full text-base h-11 px-3 dark:text-gray-100" />
              </div>
              <div>
                <Label htmlFor="agentDescription" className="text-sm font-medium text-gray-700 dark:text-gray-300">Description</Label>
                <Textarea id="agentDescription" placeholder="e.g., Helps with generating quarterly financial reports..." value={agentDescription} onChange={(e) => setAgentDescription(e.target.value)} className="mt-1 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-lg w-full h-24 p-3 text-base dark:text-gray-100" />
              </div>
              <div>
                <Label htmlFor="agentPrompt" className="text-sm font-medium text-gray-700 dark:text-gray-300">Prompt</Label>
                <Textarea id="agentPrompt" placeholder="e.g., You are a helpful assistant..." value={agentPrompt} onChange={(e) => setAgentPrompt(e.target.value)} className="mt-1 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-lg w-full h-36 p-3 text-base dark:text-gray-100" />
              </div>
              <div>
                <Label className="text-base font-medium text-gray-800 dark:text-gray-300">App Integrations</Label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 mb-3">Select knowledge sources for your agent.</p>
                <div className="flex flex-wrap items-center gap-2 p-3 border border-gray-300 dark:border-gray-600 rounded-lg min-h-[48px] bg-white dark:bg-slate-700">
                  {currentSelectedIntegrationObjects.length === 0 && <span className="text-gray-400 dark:text-gray-500 text-sm">Add integrations..</span>}
                  {currentSelectedIntegrationObjects.map((int) => <CustomBadge key={int.id} text={int.name} icon={int.icon} onRemove={() => handleRemoveSelectedIntegration(int.id)} />)}
                  <DropdownMenu open={isIntegrationMenuOpen} onOpenChange={setIsIntegrationMenuOpen}>
                    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="ml-auto p-1 h-7 w-7 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"><PlusCircle size={20} /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent className="w-72 md:w-80 max-h-80 overflow-y-auto" align="start">
                      <div className="flex items-center justify-between px-2 py-1.5"><DropdownMenuLabel className="p-0 text-sm font-medium">Select Integrations</DropdownMenuLabel>{currentSelectedIntegrationObjects.length > 0 && (<Button variant="ghost" size="sm" onClick={handleClearAllIntegrations} className="p-1 h-auto text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"><RotateCcw size={14} className="mr-1" /> Clear all</Button>)}</div><DropdownMenuSeparator />
                      {allAvailableFormIntegrations.map((int) => <DropdownMenuItem key={int.id} onSelect={() => toggleIntegrationSelection(int.id)} className="flex items-center justify-between cursor-pointer text-sm py-2 px-2 hover:bg-slate-50 dark:hover:bg-slate-600"><div className="flex items-center"><span className="mr-2 flex items-center">{int.icon}</span><span>{int.name}</span></div>{selectedIntegrations[int.id] && <Check className="h-4 w-4 text-slate-700 dark:text-slate-200" />}</DropdownMenuItem>)}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
              <div>
                <Label className="text-base font-medium text-gray-800 dark:text-gray-300">Agent Users {formSelectedUsers.length > 0 && <span className="text-sm text-gray-500 dark:text-gray-400 ml-1">({formSelectedUsers.length})</span>}</Label>
                <div className="mt-3"><div className="relative w-full"><Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-gray-500" /><Input placeholder="Search users by name or email..." value={formUserSearchQuery} onChange={(e) => setFormUserSearchQuery(e.target.value)} onKeyDown={handleFormUserKeyDown} className="pl-10 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-lg w-full dark:text-gray-100" />
                  {formShowUserSearchResults && (<Card className="absolute z-10 mt-1 shadow-lg w-full"><CardContent className="p-0 max-h-[125px] overflow-y-auto w-full scrollbar-thin" ref={formUserSearchResultsRef} style={{ scrollbarWidth: "thin" }}>
                    {formFilteredUsers.length > 0 ? formFilteredUsers.map((u, idx) => (<div key={u.id} className={`flex items-center justify-between p-2 hover:bg-gray-50 dark:hover:bg-slate-600 cursor-pointer border-b dark:border-slate-700 last:border-b-0 ${idx === formSelectedUserSearchIndex ? "bg-gray-50 dark:bg-slate-600" : ""}`} onClick={() => handleSelectFormUser(u)}><div className="flex items-center space-x-2 min-w-0 flex-1 pr-2"><span className="text-sm text-gray-600 dark:text-gray-300 truncate">{u.name}</span><span className="text-gray-500 dark:text-gray-400 flex-shrink-0">-</span><span className="text-gray-500 dark:text-gray-400 truncate">{u.email}</span></div><UserPlusIcon className="h-4 w-4 text-gray-400 dark:text-gray-500 flex-shrink-0" /></div>)) : <div className="p-3 text-center text-gray-500 dark:text-gray-400">No users found</div>}
                  </CardContent></Card>)}
                </div></div>
              </div>
              <div>
                <Card className="mt-3"><CardContent className="p-4"><div className="space-y-1.5 h-[126px] overflow-y-auto scrollbar-thin">
                  {formSelectedUsers.length > 0 ? formSelectedUsers.map(u => (<div key={u.id} className="flex items-center justify-between p-1.5 bg-gray-50 dark:bg-slate-600 rounded-lg"><div className="flex items-center space-x-2 min-w-0 flex-1 pr-2"><span className="text-sm text-gray-600 dark:text-gray-300 truncate">{u.name}</span><span className="text-gray-500 dark:text-gray-400 flex-shrink-0">-</span><span className="text-gray-500 dark:text-gray-400 truncate">{u.email}</span></div><Button variant="ghost" size="sm" onClick={() => handleRemoveFormUser(u.id)} className="text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-500 h-6 w-6 p-0 flex-shrink-0"><LucideX className="h-3 w-3" /></Button></div>)) : (<div className="text-center py-4 text-gray-500 dark:text-gray-400"><UserPlusIcon className="h-8 w-8 mx-auto mb-2 text-gray-300 dark:text-gray-600" /><p>No users added yet</p><p className="text-sm">Search and select users</p></div>)}
                </div></CardContent></Card>
              </div>
              <div className="flex justify-end w-full mt-8">
                <Button onClick={handleSaveAgent} className="bg-slate-800 dark:bg-blue-600 hover:bg-slate-700 dark:hover:bg-blue-500 text-white rounded-lg px-8 py-3 text-sm font-medium">
                  {editingAgent ? "Save Changes" : "Create Agent"}
                </Button>
              </div>
            </div>
          </div>
          {/* Right Column: Test Agent Panel */}
          <div className="w-full md:w-[50%] bg-gray-50 dark:bg-[#1E1E1E] flex flex-col h-full">
            <div className="p-4 md:px-8 md:py-6 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
              <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-100">TEST AGENT</h2>
              {agentsForTestPanel.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="ml-auto text-xs h-8">
                      {testPanelSelectedChatAgentExternalId ? agentsForTestPanel.find(a => a.externalId === testPanelSelectedChatAgentExternalId)?.name || "Select Agent" : "Test Current Form Config"}
                      <ChevronDown className="ml-2 h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuItem onSelect={() => setTestPanelSelectedChatAgentExternalId(null)}>Test Current Form Config</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Or select a saved agent</DropdownMenuLabel>
                    {agentsForTestPanel.map(agent => <DropdownMenuItem key={agent.externalId} onSelect={() => setTestPanelSelectedChatAgentExternalId(agent.externalId)}>{agent.name}</DropdownMenuItem>)}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            <div className="flex flex-col flex-grow overflow-y-auto p-4 md:p-6 space-y-4 min-h-0 max-h-[calc(100vh-200px)] scrollbar-thin" ref={testPanelMessagesContainerRef} onScroll={handleTestPanelScroll} style={{ scrollbarWidth: "thin", scrollbarColor: "#D1D5DB transparent" }}>
              {testPanelMessages.map((message, index) => <AgentChatMessage key={message.externalId ?? index} message={message.message} isUser={message.messageRole === "user"} thinking={message.thinking} citations={message.sources} messageId={message.externalId} handleRetry={handleTestPanelRetry} citationMap={message.citationMap} dots={testPanelIsStreaming && index === testPanelMessages.length - 1 && message.messageRole === "assistant" ? testPanelDots : ""} isStreaming={testPanelIsStreaming && index === testPanelMessages.length - 1 && message.messageRole === "assistant"} />)}
              {testPanelCurrentResp && <AgentChatMessage message={testPanelCurrentResp.resp} citations={testPanelCurrentResp.sources} thinking={testPanelCurrentResp.thinking || ""} isUser={false} handleRetry={handleTestPanelRetry} dots={testPanelDots} messageId={testPanelCurrentResp.messageId} citationMap={testPanelCurrentResp.citationMap} isStreaming={testPanelIsStreaming} />}
            </div>
            <div className="p-2 md:p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#1E1E1E] flex justify-center">
              <ChatBox role={user?.role} query={testPanelQuery} setQuery={setTestPanelQuery} handleSend={handleTestPanelSend} handleStop={handleTestPanelStop} isStreaming={testPanelIsStreaming} allCitations={new Map()} isReasoningActive={isTestPanelReasoningActive} setIsReasoningActive={setIsTestPanelReasoningActive} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- Render Directory View (Original) ---
  return (
    <div className="h-full w-full flex flex-row bg-white dark:bg-[#1E1E1E]">
      <Sidebar photoLink={user?.photoLink ?? ""} role={user?.role} isAgentMode={agentWhiteList} />
      <div className="h-full w-full flex flex-col relative overflow-y-auto md:ml-[60px]">
        <div className="p-4 mt-[0px]">
          <div className="w-full max-w-3xl mx-auto px-4 py-6">
            <div className="flex flex-col space-y-6">
              <div className="flex justify-between items-center">
                <h1 className="text-4xl font-bold tracking-wider doto-heading">AGENTS</h1>
                <div className="flex items-center gap-4">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-5 w-5" />
                    <input type="text" placeholder="Search agents.." value={directoryState.searchQuery} onChange={handleDirectorySearchChange} className="pl-10 pr-4 py-2 rounded-full border border-gray-200 w-[300px] focus:outline-none focus:ring-2 focus:ring-gray-200 dark:bg-slate-700 dark:border-slate-600 dark:text-gray-100" />
                  </div>
                  <button onClick={handleShowCreateAgentForm} className="bg-gray-800 hover:bg-gray-700 text-white rounded-full px-6 py-2 flex items-center gap-2 font-medium"><Plus size={18} />CREATE</button>
                </div>
              </div>
              {favoriteAgentsList.length > 0 && (<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 mb-6 pb-12">{favoriteAgentsList.map((agent) => <AgentCard key={agent.id} agent={agent} isFavorite={directoryState.favoriteAgents.includes(agent.id)} onToggleFavorite={toggleFavorite} />)}</div>)}
              <div className="flex items-center justify-between mb-2">
                <div className="flex space-x-2">
                  <TabButton active={directoryState.activeTab === "all"} onClick={() => handleTabChange("all")} icon="asterisk" label="ALL" />
                  <TabButton active={directoryState.activeTab === "shared-to-me"} onClick={() => handleTabChange("shared-to-me")} icon="users" label="SHARED-TO-ME" />
                  <TabButton active={directoryState.activeTab === "made-by-me"} onClick={() => handleTabChange("made-by-me")} icon="user" label="MADE-BY-ME" />
                </div>
                <div className="text-sm text-gray-500"><span className="flex items-center">POPULAR<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ml-1"><path d="M6 9l6 6 6-6" /></svg></span></div>
              </div>
              <div className="space-y-4">
                {filteredAgentsList.map((agent) => <AgentListItem key={agent.id} agent={agent} isFavorite={directoryState.favoriteAgents.includes(agent.id)} onToggleFavorite={toggleFavorite} />)}
                {filteredAgentsList.length === 0 && <div className="text-center py-8 text-gray-500 dark:text-gray-400">No agents found. Try adjusting your search or create a new agent.</div>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Helper components from agentDashboard.tsx (original) - with dark mode considerations
const getIconStyling = (iconName: string) => {
  const iconColors: Record<string, string> = {
    bug: "bg-blue-100 text-blue-500 dark:bg-blue-900/50 dark:text-blue-400",
    video: "bg-green-100 text-green-500 dark:bg-green-900/50 dark:text-green-400",
    database: "bg-purple-100 text-purple-500 dark:bg-purple-900/50 dark:text-purple-400",
    users: "bg-orange-100 text-orange-500 dark:bg-orange-900/50 dark:text-orange-400",
    download: "bg-pink-100 text-pink-500 dark:bg-pink-900/50 dark:text-pink-400",
    "pie-chart": "bg-blue-100 text-blue-500 dark:bg-blue-900/50 dark:text-blue-400",
    code: "bg-pink-100 text-pink-500 dark:bg-pink-900/50 dark:text-pink-400",
    "edit-3": "bg-purple-100 text-purple-500 dark:bg-purple-900/50 dark:text-purple-400",
    "bar-chart-2": "bg-orange-100 text-orange-500 dark:bg-orange-900/50 dark:text-orange-400",
    target: "bg-cyan-100 text-cyan-500 dark:bg-cyan-900/50 dark:text-cyan-400",
    shield: "bg-green-100 text-green-500 dark:bg-green-900/50 dark:text-green-400",
  };
  return iconColors[iconName as keyof typeof iconColors] || "bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-slate-300";
};

const AgentIconDisplay = ({ iconName, size = "default" }: { iconName: string; size?: "default" | "small" }) => {
  const styling = getIconStyling(iconName);
  const sizeClasses = size === "small" ? "w-8 h-8" : "w-10 h-10";
  const textSizeClasses = size === "small" ? "text-sm" : "text-lg";
  return (<div className={`${sizeClasses} rounded-md flex items-center justify-center ${styling}`}><span className={`${textSizeClasses} font-semibold`}>{iconName.charAt(0).toUpperCase()}</span></div>);
};

function AgentCard({ agent, isFavorite, onToggleFavorite }: { agent: Agent; isFavorite: boolean; onToggleFavorite: (id: string) => void; }) {
  return (
    <Card className="bg-gray-50 dark:bg-slate-800 p-6 rounded-3xl relative hover:bg-gray-100 dark:hover:bg-slate-700/60 transition-colors flex flex-col border-none shadow-none">
      <button onClick={() => onToggleFavorite(agent.id)} className="absolute top-4 right-4 text-amber-400 hover:text-amber-500 z-10"><Star fill={isFavorite ? "currentColor" : "none"} size={20} /></button>
      <div><AgentIconDisplay iconName={agent.icon} size="default" /></div>
      <div className="flex items-center gap-16 mt-4"><CardTitle className="text-lg font-medium text-gray-900 dark:text-gray-100">{agent.name}</CardTitle>{agent.type === "personal" && agent.isSharedByMe && (<Users size={18} className="text-gray-500 dark:text-gray-400" />)}</div>
      <p className="text-gray-500 dark:text-gray-400 text-sm mt-1 line-clamp-3">{agent.description}</p>
    </Card>
  );
}

function AgentListItem({ agent, isFavorite, onToggleFavorite }: { agent: Agent; isFavorite: boolean; onToggleFavorite: (id: string) => void; }) {
  return (
    <Card className="flex items-center justify-between py-4 border-b-2 border-dotted border-gray-200 dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-800/50 px-2 rounded transition-colors border-x-0 border-t-0 shadow-none bg-transparent">
      <div className="flex items-center gap-4">
        <AgentIconDisplay iconName={agent.icon} size="small" />
        <div><CardTitle className="font-medium text-base leading-tight text-gray-900 dark:text-gray-100">{agent.name}</CardTitle><CardDescription className="text-gray-500 dark:text-gray-400 text-sm mt-0.5">{agent.description}</CardDescription></div>
      </div>
      <div className="flex items-center gap-3">{agent.type === "personal" && agent.isSharedByMe && (<Users size={18} className="text-gray-500 dark:text-gray-400" />)}<button onClick={() => onToggleFavorite(agent.id)} className="text-amber-400 hover:text-amber-500"><Star fill={isFavorite ? "currentColor" : "none"} size={18} /></button></div>
    </Card>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: string; label: string; }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-full transition-colors ${active ? "bg-gray-200 text-gray-800 dark:bg-slate-700 dark:text-gray-100" : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-800/60"}`}>
      {icon === "asterisk" && <span className="text-lg">*</span>}
      {icon === "users" && (<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>)}
      {icon === "user" && (<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>)}
      {label}
    </button>
  );
}
