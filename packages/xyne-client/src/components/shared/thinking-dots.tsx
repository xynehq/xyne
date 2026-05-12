interface ThinkingDotsProps {
	className?: string;
	dotClassName?: string;
}

export function ThinkingDots({ className, dotClassName }: ThinkingDotsProps) {
	const dot = `h-1.5 w-1.5 rounded-full bg-gray-400 xyne-thinking-dot ${dotClassName ?? ""}`;
	return (
		<div className={`flex items-center gap-1.5 ${className ?? ""}`}>
			<span className={dot} />
			<span
				className={dot}
				style={{ animationDelay: "300ms" }}
			/>
			<span
				className={dot}
				style={{ animationDelay: "600ms" }}
			/>
		</div>
	);
}
