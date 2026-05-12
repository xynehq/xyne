import { XyneLogomark } from "../branding/xyne-logo";

interface BotAvatarProps {
	className?: string;
}

export function BotAvatar({ className }: BotAvatarProps) {
	return (
		<div className={`shrink-0 w-6 h-6 rounded-full bg-red-50 flex items-center justify-center mt-0.5 ${className ?? ""}`}>
			<XyneLogomark width={14} color="#FF4F4F" />
		</div>
	);
}
