import { useChat } from "../../hooks/use-chat";
import type { ChatPanelClassNames } from "../class-names";
import { ChatInput } from "./chat-input";
import { MessageList } from "./message-list";

export interface ChatPanelProps {
	placeholder?: string;
	classNames?: ChatPanelClassNames;
	suggestedPrompts?: string[];
	welcomeMessage?: string;
	renderAvatar?: () => React.ReactNode;
}

export function ChatPanel({ placeholder, classNames, suggestedPrompts, welcomeMessage, renderAvatar }: ChatPanelProps) {
	const { messages, isStreaming, error, sendMessage, stop } = useChat();

	return (
		<div className={`flex flex-col h-full bg-gray-50 ${classNames?.root ?? ""}`}>
			<MessageList
				messages={messages}
				isStreaming={isStreaming}
				classNames={classNames}
				suggestedPrompts={suggestedPrompts}
				welcomeMessage={welcomeMessage}
				onSuggestedPromptClick={sendMessage}
				renderAvatar={renderAvatar}
			/>
			<ChatInput
				onSend={sendMessage}
				onStop={stop}
				isStreaming={isStreaming}
				placeholder={placeholder}
				classNames={classNames}
			/>
		</div>
	);
}
