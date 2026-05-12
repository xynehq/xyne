import type { ChatSource } from "../../core/types";

interface SourceListProps {
	sources: ChatSource[];
	listClassName?: string;
	cardClassName?: string;
}

export function SourceList({ sources, listClassName, cardClassName }: SourceListProps) {
	if (sources.length === 0) return null;

	return (
		<div className={`flex flex-wrap gap-2 mt-3 pt-3 border-t border-gray-100 ${listClassName ?? ""}`}>
			{sources.map((source) => {
				const content = (
					<div
						className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-gray-600 hover:border-gray-300 hover:shadow-sm transition-all max-w-[200px] ${cardClassName ?? ""}`}
					>
						<svg
							className="shrink-0 w-3 h-3 text-gray-400"
							viewBox="0 0 12 12"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
						>
							<path d="M3 1h4l3 3v7H3V1z" />
							<path d="M7 1v3h3" />
						</svg>
						<span className="truncate">{source.title}</span>
					</div>
				);

				if (source.sourceUrl) {
					return (
						<a
							key={source.docId}
							href={source.sourceUrl}
							target="_blank"
							rel="noopener noreferrer"
						>
							{content}
						</a>
					);
				}

				return <div key={source.docId}>{content}</div>;
			})}
		</div>
	);
}
