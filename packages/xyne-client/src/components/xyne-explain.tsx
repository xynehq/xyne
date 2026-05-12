import { useCallback, useEffect, useState } from "react";
import { XyneProvider } from "./xyne-provider";
import { TextSelectionTrigger } from "./ai-popover/text-selection-trigger";
import type { AIPopoverClassNames } from "./class-names";

export interface XyneExplainProps {
	baseUrl: string;
	getToken: () => Promise<string>;
	children: React.ReactNode;
	disabled?: boolean;
	minSelectionLength?: number;
	triggerLabel?: string;
	triggerIcon?: React.ReactNode;
	classNames?: AIPopoverClassNames;
}

export function XyneExplain({
	baseUrl,
	getToken,
	children,
	disabled,
	minSelectionLength,
	triggerLabel,
	triggerIcon,
	classNames,
}: XyneExplainProps) {
	const [token, setToken] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		getToken()
			.then((t) => { if (!cancelled) setToken(t); })
			.catch(() => { /* silently fail — explain is non-critical */ });
		return () => { cancelled = true; };
	}, [getToken]);

	const handleTokenExpired = useCallback(async () => {
		const newToken = await getToken();
		setToken(newToken);
		return newToken;
	}, [getToken]);

	// If token hasn't loaded yet, render children without the explain feature
	if (!token) {
		return <>{children}</>;
	}

	return (
		<XyneProvider baseUrl={baseUrl} token={token} onTokenExpired={handleTokenExpired}>
			<TextSelectionTrigger
				disabled={disabled}
				minSelectionLength={minSelectionLength}
				triggerLabel={triggerLabel}
				triggerIcon={triggerIcon}
				classNames={classNames}
			>
				{children}
			</TextSelectionTrigger>
		</XyneProvider>
	);
}
