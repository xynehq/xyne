import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AIPopoverClassNames } from "../class-names";
import { XyneLogomark } from "../branding/xyne-logo";
import { AIPopover } from "./ai-popover";

export interface TextSelectionTriggerProps {
	children: React.ReactNode;
	disabled?: boolean | undefined;
	minSelectionLength?: number | undefined;
	triggerLabel?: string | undefined;
	triggerIcon?: React.ReactNode | undefined;
	classNames?: AIPopoverClassNames | undefined;
}

export function TextSelectionTrigger({
	children,
	disabled = false,
	minSelectionLength = 3,
	triggerLabel = "Explain with AI",
	triggerIcon = <XyneLogomark width={14} color="#FF4F4F" />,
	classNames,
}: TextSelectionTriggerProps) {
	const wrapperRef = useRef<HTMLDivElement>(null);
	const [selection, setSelection] = useState<{ text: string; rect: DOMRect } | null>(null);
	const [popoverState, setPopoverState] = useState<{ query: string; range: Range } | null>(null);

	// Monitor text selection within the wrapper
	useEffect(() => {
		if (disabled) return;

		function handleMouseUp(e: MouseEvent) {
			// Don't process if clicking inside toolbar or popover
			const target = e.target as HTMLElement;
			if (target.closest("[data-xyne-toolbar]") || target.closest(".xyne-popover")) {
				return;
			}

			requestAnimationFrame(() => {
				const sel = window.getSelection();
				if (!sel || sel.isCollapsed || !sel.rangeCount) {
					// Only clear if popover is not open
					if (!popoverState) {
						setSelection(null);
					}
					return;
				}

				const text = sel.toString().trim();
				if (text.length < minSelectionLength) {
					setSelection(null);
					return;
				}

				// Check if selection is within our wrapper
				const range = sel.getRangeAt(0);
				if (!wrapperRef.current?.contains(range.commonAncestorContainer)) {
					setSelection(null);
					return;
				}

				const rect = range.getBoundingClientRect();
				setSelection({ text, rect });
			});
		}

		document.addEventListener("mouseup", handleMouseUp);
		return () => document.removeEventListener("mouseup", handleMouseUp);
	}, [disabled, minSelectionLength, popoverState]);

	const handleToolbarClick = useCallback(() => {
		if (!selection) return;
		const sel = window.getSelection();
		if (!sel || !sel.rangeCount) return;

		// Save the live Range — don't clear the selection
		const range = sel.getRangeAt(0).cloneContents() ? sel.getRangeAt(0) : null;
		if (!range) return;

		setPopoverState({ query: selection.text, range });
		setSelection(null); // hide toolbar
	}, [selection]);

	const handlePopoverClose = useCallback(() => {
		setPopoverState(null);
		window.getSelection()?.removeAllRanges();
	}, []);

	// Position toolbar centered above selection
	const toolbarPos = selection
		? {
				top: selection.rect.top - 40,
				left: Math.max(
					8,
					Math.min(
						selection.rect.left + selection.rect.width / 2,
						window.innerWidth - 100,
					),
				),
			}
		: null;

	return (
		<div ref={wrapperRef}>
			{children}

			{/* Floating "Explain with AI" button near selection */}
			{selection && !popoverState && toolbarPos &&
				createPortal(
					<button
						type="button"
						data-xyne-toolbar
						onClick={handleToolbarClick}
						className={`xyne-toolbar inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-white text-gray-700 shadow-lg border border-gray-200 hover:bg-gray-50 transition-colors cursor-pointer ${classNames?.toolbar ?? ""}`}
						style={{
							position: "fixed",
							top: toolbarPos.top,
							left: toolbarPos.left,
							transform: "translateX(-50%)",
							zIndex: 9999,
						}}
					>
						{triggerIcon}
						<span>{triggerLabel}</span>
					</button>,
					document.body,
				)}

			{/* AI Popover */}
			<AIPopover
				anchorRange={popoverState?.range ?? null}
				query={popoverState?.query ?? ""}
				isOpen={popoverState !== null}
				onClose={handlePopoverClose}
				classNames={classNames}
			/>
		</div>
	);
}
