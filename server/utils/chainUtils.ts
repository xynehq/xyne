import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import {
  type QueryRouterLLMResponse,
} from "../ai/types"
import { type SelectMessage } from "@/db/schema"

const Logger = getLogger(Subsystem.Chat)

export interface ChainBreakClassification {
  messageIndex: number;
  classification: QueryRouterLLMResponse;
  query: string;
}

function parseQueryRouterClassification(queryRouterClassification: any, messageIndex: number): QueryRouterLLMResponse | null {
  if (!queryRouterClassification) return null;
  
  try {
    const parsedClassification = typeof queryRouterClassification === "string"
      ? JSON.parse(queryRouterClassification)
      : queryRouterClassification;
    return parsedClassification as QueryRouterLLMResponse;
  } catch (error) {
    Logger.warn(`Failed to parse classification for message ${messageIndex}:`, error);
    return null;
  }
}

 export function extractChainBreakClassifications(messages: SelectMessage[]): ChainBreakClassification[] {
  const chainBreaks: ChainBreakClassification[] = [];
  
  messages.forEach((message, index) => {
    if (message.messageRole === 'user' && message.queryRouterClassification) {
      const classification = parseQueryRouterClassification(message.queryRouterClassification, index);
      if (!classification) return;
    
      // When a chain break is detected (isFollowUp: false) and it's not the first message,
      // store the PREVIOUS message's classification (the last in the broken chain)
      if (classification.isFollowUp === false && index > 0) {
        const previousMessage = messages[index - 1];
        
        if (previousMessage && previousMessage.messageRole === 'user' && previousMessage.queryRouterClassification) {
          const previousClassification = parseQueryRouterClassification(previousMessage.queryRouterClassification, index - 1);
          if (!previousClassification) return;
          
          chainBreaks.push({
            messageIndex: index - 1, // Store previous message index
            classification: previousClassification, // Store previous message's classification
            query: previousMessage.message || '' // Store previous message's query
          });
        }
      }
    }
  });
  
  return chainBreaks.reverse();
}


export function getRecentChainBreakClassifications(messages: SelectMessage[]): ChainBreakClassification[] {  
  const chainBreaks = extractChainBreakClassifications(messages);
  const recentChainBreaks = chainBreaks.slice(0, 2);   // limit to the last 2 chain breaks
  return recentChainBreaks;
}

export function formatChainBreaksForPrompt(chainBreaks: ChainBreakClassification[]) {  
  if (chainBreaks.length === 0) {
    Logger.info('No chain breaks to format - returning null');
    return null;
  }
  
  const formatted = {
    availableChainBreaks: chainBreaks.map((chainBreak, index) => ({
      chainIndex: index + 1,
      messageIndex: chainBreak.messageIndex,
      originalQuery: chainBreak.query,
      classification: chainBreak.classification,
    })),
    usage: 'These are previous conversation chains that were broken. The current query might relate to one of these earlier topics.'
  };  
  return formatted;
}
