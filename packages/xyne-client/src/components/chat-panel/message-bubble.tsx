import type { ChatMessage } from "../../hooks/use-chat";
import { MarkdownContent } from "../shared/markdown-content";
import { BotAvatar } from "../shared/bot-avatar";
import { SourceList } from "../shared/source-list";

interface MessageBubbleProps {
	message: ChatMessage;
	className?: string;
	contentClassName?: string;
	sourceListClassName?: string;
	sourceCardClassName?: string;
	botAvatarClassName?: string;
	renderAvatar?: () => React.ReactNode;
}

export function MessageBubble({
	message,
	className,
	contentClassName,
	sourceListClassName,
	sourceCardClassName,
	botAvatarClassName,
	renderAvatar,
}: MessageBubbleProps) {
	const isUser = message.role === "user";
	const isError = message.status === "error";

	const content = message.content || (isError ? "Something went wrong. Please try again." : "");

	if (isUser) {
		return (
			<div
				className={`ml-auto bg-gray-900 text-white rounded-2xl rounded-br-md px-4 py-2.5 max-w-[80%] ${className ?? ""}`}
			>
				<div className={`whitespace-pre-wrap break-words text-sm ${contentClassName ?? ""}`}>
					{content}
				</div>
			</div>
		);
	}

	const bubbleClass = isError
		? "bg-red-50 text-red-700 border border-red-100 rounded-2xl rounded-bl-md px-4 py-2.5"
		: "bg-white text-gray-800 border border-gray-100 rounded-2xl rounded-bl-md px-4 py-2.5";

	return (
		<div className="flex items-start gap-2.5 max-w-[88%]">
			<BotAvatar className={botAvatarClassName} renderAvatar={renderAvatar} />
			<div className={`min-w-0 ${bubbleClass} ${className ?? ""}`}>
				{isError && (
					<div className="text-xs font-semibold text-red-500 mb-1">Error</div>
				)}
				<MarkdownContent content={content} className={`break-words ${contentClassName ?? ""}`} />
				{message.sources && message.sources.length > 0 && (
					<SourceList
						sources={message.sources}
						listClassName={sourceListClassName}
						cardClassName={sourceCardClassName}
					/>
				)}
			</div>
		</div>
	);
}
