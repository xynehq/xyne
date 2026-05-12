import React from "react";
import { XyneLogomark } from "./xyne-logo";

export interface AskAIButtonProps {
	onClick: () => void;
	isActive?: boolean;
	visible?: boolean;
	className?: string;
	label?: string;
}

/** Header button to toggle AI chat. Consumer controls visibility via `visible` prop. */
export function AskAIButton({
	onClick,
	isActive = false,
	visible = true,
	className,
	label = "Ask AI",
}: AskAIButtonProps) {
	if (!visible) return null;

	return (
		<button
			type="button"
			onClick={onClick}
			className={className}
			style={{
				height: 30,
				padding: "0 12px",
				borderRadius: 8,
				background: isActive ? "#fff1f1" : "#f1f5f9",
				color: isActive ? "#FF4F4F" : "#64748b",
				border: `1px solid ${isActive ? "#fca5a5" : "#e2e8f0"}`,
				cursor: "pointer",
				display: "flex",
				alignItems: "center",
				gap: 6,
				fontSize: 13,
				whiteSpace: "nowrap",
				transition: "all 0.2s ease",
			}}
		>
			<XyneLogomark width={14} color={isActive ? "#FF4F4F" : "#64748b"} />
			<span>{label}</span>
		</button>
	);
}
