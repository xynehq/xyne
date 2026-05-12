import { useCallback, useEffect, useState } from "react";
import { XyneProvider } from "./xyne-provider";
import { ChatPanel } from "./chat-panel/chat-panel";
import { XyneLogomark } from "./branding/xyne-logo";
import { PoweredByXyne } from "./branding/powered-by-xyne";
import type { ChatPanelClassNames } from "./class-names";

export interface XyneChatProps {
	baseUrl: string;
	getToken: () => Promise<string>;
	placeholder?: string;
	classNames?: ChatPanelClassNames;
	suggestedPrompts?: string[];
	welcomeMessage?: string;
	title?: string;
	onClose?: () => void;
	renderMessage?: (message: { role: "user" | "assistant"; content: string }) => React.ReactNode;
}

export function XyneChat({
	baseUrl,
	getToken,
	placeholder,
	classNames,
	suggestedPrompts,
	welcomeMessage,
	title = "AI Assistant",
	onClose,
}: XyneChatProps) {
	const [token, setToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		getToken()
			.then((t) => { if (!cancelled) setToken(t); })
			.catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to get token"); });
		return () => { cancelled = true; };
	}, [getToken]);

	const handleTokenExpired = useCallback(async () => {
		const newToken = await getToken();
		setToken(newToken);
		return newToken;
	}, [getToken]);

	const header = (
		<div style={{
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			padding: "12px 16px",
			borderBottom: "1px solid #e2e8f0",
			flexShrink: 0,
		}}>
			<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
				<XyneLogomark width={20} color="#FF4F4F" />
				<span style={{ fontWeight: 600, fontSize: 15 }}>{title}</span>
			</div>
			{onClose && (
				<button
					type="button"
					onClick={onClose}
					style={{
						background: "none",
						border: "none",
						cursor: "pointer",
						padding: 4,
						display: "flex",
						color: "#64748b",
					}}
				>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>
			)}
		</div>
	);

	if (error) {
		return (
			<div className={`flex flex-col h-full bg-gray-50 ${classNames?.root ?? ""}`}>
				{header}
				<div className="flex items-center justify-center flex-1 text-sm text-red-500">
					{error}
				</div>
				<PoweredByXyne />
			</div>
		);
	}

	if (!token) {
		return (
			<div className={`flex flex-col h-full bg-gray-50 ${classNames?.root ?? ""}`}>
				{header}
				<div className="flex items-center justify-center flex-1 text-sm text-gray-400">
					Connecting...
				</div>
				<PoweredByXyne />
			</div>
		);
	}

	return (
		<div className={`flex flex-col h-full bg-gray-50 ${classNames?.root ?? ""}`}>
			{header}
			<div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 0 }}>
				<XyneProvider baseUrl={baseUrl} token={token} onTokenExpired={handleTokenExpired}>
					<ChatPanel
						placeholder={placeholder}
						classNames={classNames}
						suggestedPrompts={suggestedPrompts}
						welcomeMessage={welcomeMessage}
					/>
				</XyneProvider>
			</div>
			<PoweredByXyne />
		</div>
	);
}
