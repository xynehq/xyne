import { type FormEvent, type KeyboardEvent, useCallback, useRef, useState } from "react";
import type { ChatPanelClassNames } from "../class-names";

interface ChatInputProps {
	onSend: (query: string) => void;
	onStop: () => void;
	isStreaming: boolean;
	placeholder?: string | undefined;
	classNames?: ChatPanelClassNames | undefined;
}

export function ChatInput({
	onSend,
	onStop,
	isStreaming,
	placeholder,
	classNames,
}: ChatInputProps) {
	const [value, setValue] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const resetHeight = useCallback(() => {
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
		}
	}, []);

	const handleSubmit = useCallback(
		(e: FormEvent) => {
			e.preventDefault();
			if (isStreaming) {
				onStop();
			} else if (value.trim().length > 0) {
				onSend(value.trim());
				setValue("");
				resetHeight();
			}
		},
		[value, isStreaming, onSend, onStop, resetHeight],
	);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				if (!isStreaming && value.trim().length > 0) {
					onSend(value.trim());
					setValue("");
					resetHeight();
				}
			}
		},
		[value, isStreaming, onSend, resetHeight],
	);

	const handleInput = useCallback(() => {
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
			textareaRef.current.style.height = `${String(textareaRef.current.scrollHeight)}px`;
		}
	}, []);

	return (
		<form
			onSubmit={handleSubmit}
			className={`px-3 pt-3 pb-0 ${classNames?.inputContainer ?? ""}`}
		>
			<div className="flex items-end gap-2 rounded-2xl border border-gray-200 bg-gray-50 px-3 py-2 focus-within:border-gray-400 focus-within:bg-white transition-colors">
				<textarea
					ref={textareaRef}
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={handleKeyDown}
					onInput={handleInput}
					placeholder={placeholder ?? "Ask a question..."}
					rows={1}
					className={`flex-1 resize-none bg-transparent px-1 py-1 text-sm outline-none placeholder:text-gray-400 max-h-32 overflow-y-auto ${classNames?.input ?? ""}`}
				/>
				{isStreaming ? (
					<button
						type="submit"
						aria-label="Stop"
						className={`shrink-0 w-8 h-8 rounded-full bg-gray-200 text-gray-600 flex items-center justify-center hover:bg-gray-300 transition-all ${classNames?.stopButton ?? ""}`}
					>
						<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
							<rect x="2" y="2" width="10" height="10" rx="2" />
						</svg>
					</button>
				) : (
					<button
						type="submit"
						aria-label="Send"
						disabled={value.trim().length === 0}
						className={`shrink-0 w-8 h-8 rounded-full bg-gray-900 text-white flex items-center justify-center hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed transition-all ${classNames?.submitButton ?? ""}`}
					>
						<svg
							width="16"
							height="16"
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M8 12V4" />
							<path d="M4 7l4-3 4 3" />
						</svg>
					</button>
				)}
			</div>
		</form>
	);
}
