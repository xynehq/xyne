import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Chat)

export interface ChainBreakClassification {
  messageIndex: number;
  classification: any;
  query: string;
}

export function extractChainBreakClassifications(messages: any[]): ChainBreakClassification[] {
  const chainBreaks: ChainBreakClassification[] = [];
  
  messages.forEach((message, index) => {
    if (message.messageRole === 'user' && message.queryRouterClassification) {
      let classification;
      
      if (typeof message.queryRouterClassification === 'string') {
        try {
          classification = JSON.parse(message.queryRouterClassification);
        } catch (error) {
          Logger.warn(`Failed to parse classification for message ${index}:`, error);
          return;
        }
      } else {
        classification = message.queryRouterClassification;
      }
    
      // When a chain break is detected (isFollowUp: false) and it's not the first message,
      // store the PREVIOUS message's classification (the last in the broken chain)
      if (classification.isFollowUp === false && index > 0) {
        const previousMessage = messages[index - 1];
        
        if (previousMessage && previousMessage.messageRole === 'user' && previousMessage.queryRouterClassification) {
          let previousClassification;
          
          if (typeof previousMessage.queryRouterClassification === 'string') {
            try {
              previousClassification = JSON.parse(previousMessage.queryRouterClassification);
            } catch (error) {
              Logger.warn(`Failed to parse previous classification for message ${index - 1}:`, error);
              return;
            }
          } else {
            previousClassification = previousMessage.queryRouterClassification;
          }
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


export function getRecentChainBreakClassifications(messages: any[]): ChainBreakClassification[] {  
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
