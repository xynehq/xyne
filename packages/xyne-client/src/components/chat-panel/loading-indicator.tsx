import { ThinkingDots } from "../shared/thinking-dots";
import { BotAvatar } from "../shared/bot-avatar";

interface LoadingIndicatorProps {
	className?: string;
	botAvatarClassName?: string;
	dotClassName?: string;
	renderAvatar?: () => React.ReactNode;
}

export function LoadingIndicator({ className, botAvatarClassName, dotClassName, renderAvatar }: LoadingIndicatorProps) {
	return (
		<div className={`flex items-start gap-2.5 ${className ?? ""}`}>
			<BotAvatar className={botAvatarClassName} renderAvatar={renderAvatar} />
			<div className="bg-white rounded-2xl rounded-bl-md px-4 py-3 border border-gray-100">
				<ThinkingDots dotClassName={dotClassName} />
			</div>
		</div>
	);
}
