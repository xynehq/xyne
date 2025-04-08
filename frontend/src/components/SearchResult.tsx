import HighlightedText from "@/components/Highlight"
import { getIcon } from "@/lib/common"
import { SearchResultDiscriminatedUnion } from "@/server/shared/types"
import { useEffect } from "react"

export const SearchResult = ({
  result,
  index,
}: { result: SearchResultDiscriminatedUnion; index: number }) => {
  // Add effect to fetch WhatsApp groups when component renders with WhatsApp message
  useEffect(() => {
    // Only fetch groups for WhatsApp messages
    if (result.app === "whatsapp") {
      console.log("WhatsApp message detected, fetching groups from Vespa");
      
      // Function to fetch groups from Vespa
      const fetchWhatsAppGroups = async () => {
        try {
          // Use fetch directly to avoid import issues
          const response = await fetch("/api/v1/whatsapp/groups");
          if (response.ok) {
            const data = await response.json();
            console.log("WhatsApp groups from Vespa:", data);
            
            // Extract the group ID from the message
            const whatsappResult = result as any;
            const messageGroupId = whatsappResult.teamId || whatsappResult.channelId || whatsappResult.docId;
            console.log("This message's group ID:", messageGroupId);
            
            // Try to find a matching group
            if (data.groups && data.groups.length > 0) {
              // Look for exact match
              const exactMatch = data.groups.find((group: any) => group.jid === messageGroupId);
              if (exactMatch) {
                console.log("Exact group match found:", exactMatch.name);
              } else {
                // Try without @g.us suffix
                const baseId = messageGroupId ? String(messageGroupId).split('@')[0] : '';
                const partialMatch = data.groups.find((group: any) => group.jid.includes(baseId));
                if (partialMatch) {
                  console.log("Partial group match found:", partialMatch.name);
                } else {
                  console.log("No matching group found for this message");
                }
              }
            } else {
              console.log("No WhatsApp groups returned from Vespa");
            }
          } else {
            console.error("Failed to fetch WhatsApp groups:", await response.text());
          }
        } catch (error) {
          console.error("Error fetching WhatsApp groups:", error);
        }
      };
      
      // Execute the fetch
      fetchWhatsAppGroups();
    }
  }, [result]); // Re-run when result changes

  let content = <></>
  let commonClassVals = "pr-[60px]"
  if (result.type === "file") {
    content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start space-x-2">
          <a
            href={result.url ?? ""}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-blue-800 space-x-2"
          >
            {getIcon(result.app, result.entity, { w: 24, h: 24, mr: 20 })}
            {result.title}
          </a>
        </div>
        <div className="flex flex-row items-center mt-1 ml-[44px]">
          <img
            referrerPolicy="no-referrer"
            className="mr-2 w-[16px] h-[16px] rounded-full"
            src={result.photoLink ?? ""}
          ></img>
          <a
            target="_blank"
            className="text-[#2067F5]"
            rel="noopener noreferrer"
            href={`https://contacts.google.com/${result.ownerEmail}`}
          >
            <p className="text-left text-sm pt-1 text-[#464B53]">
              {result.owner}
            </p>
          </a>
        </div>
        {result.chunks_summary &&
          result.chunks_summary?.length &&
          result.chunks_summary
            .slice(0, 1)
            .map((summary) => <HighlightedText chunk_summary={summary} />)}
      </div>
    )
  } else if (result.type === "user") {
    content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start">
          <a
            href={`https://contacts.google.com/${result.email}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-[#2067F5]"
          >
            {/* TODO: if photoLink doesn't exist then show icon */}
            <img
              referrerPolicy="no-referrer"
              className="mr-2 w-[16px] h-[16px] rounded-full"
              src={result.photoLink}
            ></img>
            {result.name || result.email}
          </a>
        </div>
      </div>
    )
  } else if (result.type === "mail") {
    content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start">
          {getIcon(result.app, result.entity, { w: 24, h: 24, mr: 20 })}
          <a
            href={`https://mail.google.com/mail/u/0/#inbox/${result.docId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-[#2067F5]"
          >
            {/* TODO: if photoLink doesn't exist then show icon */}
            {/* <img
              referrerPolicy="no-referrer"
              className="mr-2 w-[16px] h-[16px] rounded-full"
              src={result.photoLink}
            ></img> */}
            {result.subject}
          </a>
        </div>
        {result.chunks_summary &&
          result.chunks_summary?.length &&
          result.chunks_summary
            .slice(0, 1)
            .map((summary) => <HighlightedText chunk_summary={summary} />)}
      </div>
    )
  } else if (result.type === "event") {
    content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start">
          {getIcon(result.app, result.entity, { w: 24, h: 24, mr: 20 })}
          <a
            href={result.url ?? ""}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-[#2067F5]"
          >
            {/* TODO: if photoLink doesn't exist then show icon */}
            {/* <img
              referrerPolicy="no-referrer"
              className="mr-2 w-[16px] h-[16px] rounded-full"
              src={result.photoLink}
            ></img> */}
            {result.name}
          </a>
        </div>
        <p className="text-left text-sm mt-1 text-[#464B53] line-clamp-[2.5] text-ellipsis overflow-hidden ml-[44px]">
          {result.description ?? ""}
        </p>
      </div>
    )
  } else if (result.type === "mail_attachment") {
    content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start">
          {getIcon(result.app, result.entity, { w: 24, h: 24, mr: 20 })}
          <a
            href={`https://mail.google.com/mail/u/0/#inbox/${result.mailId}?projector=1&messagePartId=0.${result.partId}&disp=safe&zw`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-[#2067F5]"
          >
            {result.filename}
          </a>
        </div>
        {result.chunks_summary &&
          result.chunks_summary?.length &&
          result.chunks_summary
            .slice(0, 1)
            .map((summary) => <HighlightedText chunk_summary={summary} />)}
      </div>
    )
  }
  else if (result.app === "whatsapp") {
      // Handle WhatsApp messages
      const whatsappMessage = {
        id: result.docId,
        text: result.text,
        userId: result.userId,
        username: result.username,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
        teamId: result.teamId,
        channelId: result.channelId,
        threadId: result.threadId,
        mentions: result.mentions,
        attachmentIds: result.attachmentIds,
        image: result.image,
        type: result.type,
        app: result.app
      }

      console.log("\n whatsappImage == ", whatsappMessage.image,"\n");

      content = (
        <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
          <div className="flex items-center justify-start space-x-2">
            <div className="flex items-center text-blue-800 space-x-2">
              {getIcon(result.app, result.entity, { w: 24, h: 24, mr: 20 })}
              <span className="font-medium">{whatsappMessage.username}</span>
            </div>
          </div>
          <div className="flex flex-row items-center mt-1 ml-[44px]">
            <img
              referrerPolicy="no-referrer"
              className="mr-2 w-[16px] h-[16px] rounded-full"
              src={whatsappMessage.image}
            ></img>
            
          </div>
                {result.text && <HighlightedText chunk_summary={result.text} />}

        </div>
      )
    }
    else if (result.type === "chat_message") {
    
    content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start space-x-2">
            <a
              href={`https://${result.domain}.slack.com/archives/${result.channelId}/p${result.createdAt}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center text-blue-800 space-x-2"
            >
              {getIcon(result.app, result.entity, { w: 24, h: 24, mr: 20 })}
            </a>
          </div>
        <div className="flex flex-row items-center mt-1 ml-[44px]">
          <img
            referrerPolicy="no-referrer"
            className="mr-2 w-[16px] h-[16px] rounded-full"
            src={result.image}
          ></img>
          <a
            target="_blank"
            className="text-[#2067F5]"
            rel="noopener noreferrer"
            href={`https://${result.domain}.slack.com/team/${result.userId}`}
          >
            <p className="text-left text-sm pt-1 text-[#464B53]">
              {result.name}
            </p>
          </a>
        </div>
        {result.text && <HighlightedText chunk_summary={result.text} />}
      </div>
    )
  }
  return content
}
