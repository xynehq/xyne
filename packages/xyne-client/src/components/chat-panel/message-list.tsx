import { useEffect, useRef } from "react";
import type { ChatMessage } from "../../hooks/use-chat";
import type { ChatPanelClassNames } from "../class-names";
import { LoadingIndicator } from "./loading-indicator";
import { MessageBubble } from "./message-bubble";

const DEFAULT_PROMPTS = [
	"Summarize recent documents",
	"What are the key findings?",
	"Help me understand...",
];

interface MessageListProps {
	messages: ChatMessage[];
	isStreaming: boolean;
	classNames?: ChatPanelClassNames | undefined;
	suggestedPrompts?: string[] | undefined;
	welcomeMessage?: string | undefined;
	onSuggestedPromptClick?: ((prompt: string) => void) | undefined;
}

function EmptyState({
	prompts,
	welcomeMessage,
	onPromptClick,
	classNames,
}: {
	prompts: string[];
	welcomeMessage?: string;
	onPromptClick?: (prompt: string) => void;
	classNames?: ChatPanelClassNames;
}) {
	return (
		<div
			className={`flex-1 flex flex-col items-center justify-center px-8 text-center gap-5 ${classNames?.emptyState ?? ""}`}
		>
			<div className="w-12 h-12 rounded-2xl bg-gray-100 flex items-center justify-center">
				<svg
					width="24"
					height="24"
					viewBox="0 0 24 24"
					fill="none"
					className="text-gray-400"
				>
					<path
						d="M12 3L14.4 8.4L20 9.2L16 13.3L17 19L12 16.2L7 19L8 13.3L4 9.2L9.6 8.4L12 3Z"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinejoin="round"
					/>
					<path
						d="M12 8V12M10 10H14"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
					/>
				</svg>
			</div>

			<div className="space-y-1">
				<p className="text-sm font-medium text-gray-900">How can I help you?</p>
				<p className="text-xs text-gray-500">
					{welcomeMessage ??
						"Ask me anything — I can answer questions, explain concepts, and find relevant information for you."}
				</p>
			</div>

			{prompts.length > 0 && (
				<div className="flex flex-wrap gap-2 justify-center">
					{prompts.map((prompt) => (
						<button
							key={prompt}
							type="button"
							onClick={() => onPromptClick?.(prompt)}
							className={`text-xs px-3 py-1.5 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-100 hover:border-gray-300 transition-colors cursor-pointer ${classNames?.suggestedPrompt ?? ""}`}
						>
							{prompt}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

export function MessageList({
	messages,
	isStreaming,
	classNames,
	suggestedPrompts,
	welcomeMessage,
	onSuggestedPromptClick,
}: MessageListProps) {
	const bottomRef = useRef<HTMLDivElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll to bottom when messages change
	useEffect(() => {
		bottomRef.current?.scrollIntoView?.({ behavior: "smooth" });
	}, [messages]);

	if (messages.length === 0) {
		return (
			<div
				className={`flex-1 overflow-y-auto overscroll-contain flex flex-col p-4 ${classNames?.messageList ?? ""}`}
			>
				<EmptyState
					prompts={suggestedPrompts ?? DEFAULT_PROMPTS}
					welcomeMessage={welcomeMessage}
					onPromptClick={onSuggestedPromptClick}
					classNames={classNames}
				/>
			</div>
		);
	}

	return (
		<div
			className={`flex-1 overflow-y-auto overscroll-contain flex flex-col gap-3 p-4 ${classNames?.messageList ?? ""}`}
		>
			{messages.map((msg) => {
				// Skip rendering the empty assistant bubble while streaming — the LoadingIndicator handles it
				if (
					msg.role === "assistant" &&
					msg.content === "" &&
					msg.status === "streaming"
				) {
					return null;
				}
				return (
					<MessageBubble
						key={msg.id}
						message={msg}
						className={
							msg.status === "error"
								? classNames?.errorMessage
								: msg.role === "user"
									? classNames?.userMessage
									: classNames?.assistantMessage
						}
						contentClassName={classNames?.messageContent}
						sourceListClassName={classNames?.sourceList}
						sourceCardClassName={classNames?.sourceCard}
						botAvatarClassName={classNames?.botAvatar}
					/>
				);
			})}
			{isStreaming &&
				messages.length > 0 &&
				messages[messages.length - 1]?.role === "assistant" &&
				messages[messages.length - 1]?.content === "" &&
				messages[messages.length - 1]?.status !== "error" && (
					<LoadingIndicator className={classNames?.loadingIndicator} botAvatarClassName={classNames?.botAvatar} dotClassName={classNames?.dot} />
				)}
			<div ref={bottomRef} />
		</div>
	);
}
