import React from "react";
import { XyneLogomark } from "./xyne-logo";

export interface PoweredByXyneProps {
	className?: string;
}

/** "Powered by Xyne" footer badge. Always visible when the SDK is in use. */
export function PoweredByXyne({ className }: PoweredByXyneProps) {
	return (
		<div
			className={className}
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				gap: 5,
				padding: "4px 16px",
				fontSize: 11,
				color: "#94a3b8",
				flexShrink: 0,
				lineHeight: 1,
			}}
		>
			<span>Powered by</span>
			<XyneLogomark width={13} color="#FF4F4F" />
			<span style={{ fontWeight: 600 }}>xyne</span>
		</div>
	);
}
