import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAISummary } from "../../hooks/use-ai-summary";
import { SourceList } from "../shared/source-list";
import { MarkdownContent } from "../shared/markdown-content";
import { ThinkingDots } from "../shared/thinking-dots";
import type { AIPopoverClassNames } from "../class-names";

export interface AIPopoverProps {
	anchorRange: Range | null;
	query: string;
	isOpen: boolean;
	onClose: () => void;
	headerIcon?: React.ReactNode | undefined;
	classNames?: AIPopoverClassNames | undefined;
	collection?: string | undefined;
}

const POPOVER_WIDTH = 340;
const POPOVER_MAX_HEIGHT = 420;
const OFFSET = 8;

function usePosition(anchorRange: Range | null, popoverRef: React.RefObject<HTMLDivElement | null>) {
	const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

	useEffect(() => {
		if (!anchorRange) return;

		function calculate() {
			if (!anchorRange) return;
			const rect = anchorRange.getBoundingClientRect();
			const popoverHeight = popoverRef.current?.offsetHeight ?? POPOVER_MAX_HEIGHT;

			let top = rect.bottom + OFFSET;
			if (top + popoverHeight > window.innerHeight) {
				top = rect.top - popoverHeight - OFFSET;
			}
			top = Math.max(OFFSET, top);

			let left = rect.left + rect.width / 2 - POPOVER_WIDTH / 2;
			if (left + POPOVER_WIDTH > window.innerWidth - OFFSET) {
				left = window.innerWidth - POPOVER_WIDTH - OFFSET;
			}
			left = Math.max(OFFSET, left);

			setPos({ top, left });
		}

		calculate();

		window.addEventListener("scroll", calculate, true);
		window.addEventListener("resize", calculate);
		return () => {
			window.removeEventListener("scroll", calculate, true);
			window.removeEventListener("resize", calculate);
		};
	}, [anchorRange, popoverRef]);

	return pos;
}

export function AIPopover({
	anchorRange,
	query,
	isOpen,
	onClose,
	headerIcon,
	classNames,
	collection,
}: AIPopoverProps) {
	const { content, sources, isStreaming, error, query: runQuery, stop, reset } = useAISummary(collection);
	const popoverRef = useRef<HTMLDivElement | null>(null);
	const hasQueriedRef = useRef(false);
	const pos = usePosition(anchorRange, popoverRef);

	// Trigger query when popover opens
	useEffect(() => {
		if (isOpen && query && !hasQueriedRef.current) {
			hasQueriedRef.current = true;
			runQuery(query);
		}
		if (!isOpen) {
			hasQueriedRef.current = false;
		}
	}, [isOpen, query, runQuery]);

	// Clean up on close
	useEffect(() => {
		if (!isOpen) {
			const timer = setTimeout(() => reset(), 200);
			return () => clearTimeout(timer);
		}
	}, [isOpen, reset]);

	// Click outside
	useEffect(() => {
		if (!isOpen) return;

		function handleClick(e: MouseEvent) {
			if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
				onClose();
			}
		}

		const timer = setTimeout(() => {
			document.addEventListener("mousedown", handleClick);
		}, 0);

		return () => {
			clearTimeout(timer);
			document.removeEventListener("mousedown", handleClick);
		};
	}, [isOpen, onClose]);

	// Escape key
	useEffect(() => {
		if (!isOpen) return;

		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				onClose();
			}
		}

		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
	}, [isOpen, onClose]);

	const handleRetry = useCallback(() => {
		reset();
		setTimeout(() => {
			hasQueriedRef.current = false;
			runQuery(query);
			hasQueriedRef.current = true;
		}, 0);
	}, [reset, runQuery, query]);

	if (!isOpen || !anchorRange) return null;

	return createPortal(
		<div
			ref={popoverRef}
			className={`xyne-popover ${classNames?.popover ?? ""}`}
			style={{
				position: "fixed",
				top: pos.top,
				left: pos.left,
				width: POPOVER_WIDTH,
				maxHeight: POPOVER_MAX_HEIGHT,
				zIndex: 10000,
			}}
		>
			{/* Header */}
			<div
				className={`flex items-center justify-between px-3.5 py-2.5 border-b border-gray-100 ${classNames?.popoverHeader ?? ""}`}
			>
				<div className="flex items-center gap-2">
					{headerIcon}
					<span className="text-sm font-medium text-gray-900">AI Explanation</span>
				</div>
				<button
					type="button"
					onClick={() => { stop(); onClose(); }}
					className="text-gray-400 hover:text-gray-600 p-1 rounded-md hover:bg-gray-100 transition-colors cursor-pointer"
					aria-label="Close"
				>
					<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
						<path d="M1 1l10 10M11 1L1 11" />
					</svg>
				</button>
			</div>

			{/* Body */}
			<div
				className={`overflow-y-auto p-3.5 ${classNames?.popoverBody ?? ""}`}
				style={{ maxHeight: POPOVER_MAX_HEIGHT - 48 }}
			>
				{/* Loading */}
				{isStreaming && !content && (
					<div className="py-3 flex justify-center">
						<ThinkingDots dotClassName={classNames?.dot} />
					</div>
				)}

				{/* Content */}
				{content && (
					<MarkdownContent content={content} className="text-gray-800" />
				)}

				{/* Error */}
				{error && !isStreaming && (
					<div className="flex flex-col items-center gap-2.5 py-4 text-center">
						<span className="text-xs text-red-500">{error.message}</span>
						<button
							type="button"
							onClick={handleRetry}
							className="text-xs px-3 py-1.5 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 hover:border-gray-300 transition-colors cursor-pointer"
						>
							Retry
						</button>
					</div>
				)}

				{/* Sources */}
				{sources.length > 0 && (
					<SourceList sources={sources} listClassName={classNames?.sourceList} cardClassName={classNames?.sourceCard} />
				)}
			</div>

		</div>,
		document.body,
	);
}
