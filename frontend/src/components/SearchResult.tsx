import HighlightedText from "@/components/Highlight"; // Keep for non-code results
import { getIcon } from "@/lib/common";
import { SearchResultDiscriminatedUnion, codeRustSchema } from "shared/types";
import { Code } from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { rust } from '@codemirror/lang-rust';
import { Decoration, ViewPlugin, EditorView } from '@codemirror/view'; // Import EditorView for types
import {rosePineDawn} from 'thememirror';


// --- CodeMirror Plugin for Bolding <hi> ---
const boldDecoration = Decoration.mark({
  attributes: { style: 'font-weight: bold' },
});

const boldHiTextPlugin = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view: EditorView) { // Add type annotation
      this.decorations = this.getDecorations(view);
    }
    update(update: { docChanged: boolean; viewportChanged: boolean; view: EditorView; startState: any; state: any }) { // Add type annotation
      // Check if document changed or viewport changed (important for large docs)
      if (update.docChanged || update.viewportChanged || update.startState.doc !== update.state.doc) {
        this.decorations = this.getDecorations(update.view);
      }
    }
    getDecorations(view: EditorView) { // Add type annotation
      const decorations: any[] = []; // Use any[] for simplicity or define a proper range type
      const doc = view.state.doc;
      const hiOpen = '<hi>';
      const hiClose = '</hi>';
      let cursor = 0;

      // Iterate through the document using a cursor
      while (cursor < doc.length) {
        // Find the next <hi> tag from the current cursor position
        const textAfterCursor = doc.sliceString(cursor);
        const openIndexRel = textAfterCursor.indexOf(hiOpen);
        if (openIndexRel === -1) break; // No more <hi> tags found

        const openIndexAbs = cursor + openIndexRel;

        // Find the corresponding </hi> tag after the found <hi> tag
        const textAfterOpenTag = doc.sliceString(openIndexAbs + hiOpen.length);
        const closeIndexRel = textAfterOpenTag.indexOf(hiClose);
        if (closeIndexRel === -1) {
           // Malformed tag, move cursor past the open tag to avoid infinite loop
           cursor = openIndexAbs + hiOpen.length;
           continue;
        }

        const closeIndexAbs = openIndexAbs + hiOpen.length + closeIndexRel;

        // Define ranges for tags and content
        const tagOpenStart = openIndexAbs;
        const tagOpenEnd = openIndexAbs + hiOpen.length;
        const contentStart = tagOpenEnd;
        const contentEnd = closeIndexAbs;
        const tagCloseStart = closeIndexAbs;
        const tagCloseEnd = closeIndexAbs + hiClose.length;

        // Hide the opening <hi> tag
        decorations.push(Decoration.replace({}).range(tagOpenStart, tagOpenEnd));

        // Apply bold decoration to the content between tags
        if (contentStart < contentEnd) {
          decorations.push(boldDecoration.range(contentStart, contentEnd));
        }

        // Hide the closing </hi> tag
        decorations.push(Decoration.replace({}).range(tagCloseStart, tagCloseEnd));

        // Move the cursor past the closing tag for the next search
        cursor = tagCloseEnd;
      }

      // Return the sorted set of decorations (important for proper application)
      return Decoration.set(decorations);
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);
// --- End CodeMirror Plugin ---

export const SearchResult = ({
  result,
  index,
  showDebugInfo,
}: {
  result: SearchResultDiscriminatedUnion
  index: number
  showDebugInfo?: boolean
}) => {
  let content = <></>
  let commonClassVals = "pr-[60px]" // Keep existing layout class

  // --- Render logic for different result types ---
  if (result.type === "file") {
    content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start space-x-2">
          <a
            href={result.url ?? ""}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-blue-800 space-x-2"
          >
            {getIcon(result.app, result.entity, { w: 24, h: 24, mr: 20 })}
            {result.title}
          </a>
        </div>
        <div className="flex flex-row items-center mt-1 ml-[44px]">
          <img
            referrerPolicy="no-referrer"
            className="mr-2 w-[16px] h-[16px] rounded-full"
            src={result.photoLink ?? ""}
          ></img>
          <a
            target="_blank"
            className="text-[#2067F5]"
            rel="noopener noreferrer"
            href={`https://contacts.google.com/${result.ownerEmail}`}
          >
            <p className="text-left text-sm pt-1 text-[#464B53]">
              {result.owner}
            </p>
          </a>
        </div>
        {result.chunks_summary &&
          result.chunks_summary?.length &&
          result.chunks_summary.map((summary, idx) => (
            // Use HighlightedText for non-code file summaries
            <HighlightedText key={idx} chunk_summary={summary.chunk} />
          ))}
        {/* Debug Info Display */}
        {showDebugInfo && (result.matchfeatures || result.rankfeatures) && (
          <details className="mt-2 ml-[44px] text-xs">
            <summary className="text-gray-500 cursor-pointer">
              {`Debug Info: ${index} : ${result.relevance}`}
            </summary>
            <pre className="text-xs bg-gray-100 p-2 rounded overflow-auto max-h-60">
              {JSON.stringify(
                {
                  matchfeatures: result.matchfeatures,
                  rankfeatures: result.rankfeatures,
                  relevance: result.relevance,
                },
                null,
                2,
              )}
            </pre>
          </details>
        )}
      </div>
    )
  } else if (result.type === "user") {
     // ... (user rendering logic remains the same) ...
    content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start">
          <a
            href={`https://contacts.google.com/${result.email}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-[#2067F5]"
          >
            <img
              referrerPolicy="no-referrer"
              className="mr-2 w-[16px] h-[16px] rounded-full"
              src={result.photoLink}
            ></img>
            {result.name || result.email}
          </a>
        </div>
        {showDebugInfo && (result.matchfeatures || result.rankfeatures) && (
          <details className="mt-2 ml-[44px] text-xs">
            <summary className="text-gray-500 cursor-pointer">
              {`Debug Info: ${index} : ${result.relevance}`}
            </summary>
            <pre className="text-xs bg-gray-100 p-2 rounded overflow-auto max-h-60">
              {JSON.stringify(
                {
                  matchfeatures: result.matchfeatures,
                  rankfeatures: result.rankfeatures,
                  relevance: result.relevance,
                },
                null,
                2,
              )}
            </pre>
          </details>
        )}
      </div>
    )
  } else if (result.type === "mail") {
     // ... (mail rendering logic remains the same) ...
     content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start">
          {getIcon(result.app, result.entity, { w: 24, h: 24, mr: 20 })}
          <a
            href={`https://mail.google.com/mail/u/0/#inbox/${result.docId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-[#2067F5]"
          >
            {result.subject}
          </a>
        </div>
        {result.chunks_summary &&
          result.chunks_summary?.length &&
          result.chunks_summary.map((summary, idx) => (
            <HighlightedText key={idx} chunk_summary={summary.chunk} />
          ))}
        {showDebugInfo && (result.matchfeatures || result.rankfeatures) && (
          <details className="mt-2 ml-[44px] text-xs">
            <summary className="text-gray-500 cursor-pointer">
              {`Debug Info: ${index} : ${result.relevance}`}
            </summary>
            <pre className="text-xs bg-gray-100 p-2 rounded overflow-auto max-h-60">
              {JSON.stringify(
                {
                  matchfeatures: result.matchfeatures,
                  rankfeatures: result.rankfeatures,
                  relevance: result.relevance,
                },
                null,
                2,
              )}
            </pre>
          </details>
        )}
      </div>
    )
  } else if (result.type === "event") {
     // ... (event rendering logic remains the same) ...
     content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start">
          {getIcon(result.app, result.entity, { w: 24, h: 24, mr: 20 })}
          <a
            href={result.url ?? ""}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-[#2067F5]"
          >
            {result.name}
          </a>
        </div>
        <p className="text-left text-sm mt-1 text-[#464B53] line-clamp-[2.5] text-ellipsis overflow-hidden">
          {result.chunks_summary &&
            !!result.chunks_summary.length &&
            result.chunks_summary.map((summary, idx) => (
              <HighlightedText chunk_summary={summary} key={idx} />
            ))}
        </p>
        {showDebugInfo && (result.matchfeatures || result.rankfeatures) && (
          <details className="mt-2 ml-[44px] text-xs">
            <summary className="text-gray-500 cursor-pointer">
              {`Debug Info: ${index} : ${result.relevance}`}
            </summary>
            <pre className="text-xs bg-gray-100 p-2 rounded overflow-auto max-h-60">
              {JSON.stringify(
                {
                  matchfeatures: result.matchfeatures,
                  rankfeatures: result.rankfeatures,
                  relevance: result.relevance,
                },
                null,
                2,
              )}
            </pre>
          </details>
        )}
      </div>
    )
  } else if (result.type === "mail_attachment") {
     // ... (mail_attachment rendering logic remains the same) ...
     content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start">
          {getIcon(result.app, result.entity, { w: 24, h: 24, mr: 20 })}
          <a
            href={`https://mail.google.com/mail/u/0/#inbox/${result.mailId}?projector=1&messagePartId=0.${result.partId}&disp=safe&zw`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-[#2067F5]"
          >
            {result.filename}
          </a>
        </div>
        {result.chunks_summary &&
          result.chunks_summary?.length &&
          result.chunks_summary.map((summary, idx) => (
            <HighlightedText key={idx} chunk_summary={summary.chunk} />
          ))}
        {showDebugInfo && (result.matchfeatures || result.rankfeatures) && (
          <details className="mt-2 ml-[44px] text-xs">
            <summary className="text-gray-500 cursor-pointer">
              {`Debug Info: ${index} : ${result.relevance}`}
            </summary>
            <pre className="text-xs bg-gray-100 p-2 rounded overflow-auto max-h-60">
              {JSON.stringify(
                {
                  matchfeatures: result.matchfeatures,
                  rankfeatures: result.rankfeatures,
                  relevance: result.relevance,
                },
                null,
                2,
              )}
            </pre>
          </details>
        )}
      </div>
    )
  } else if (result.type === "chat_message") {
     // ... (chat_message rendering logic remains the same) ...
     content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start space-x-2">
          <a
            href={`https://${result.domain}.slack.com/archives/${result.channelId}/p${result.createdAt}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-blue-800 space-x-2"
          >
            {getIcon(result.app, result.entity, { w: 24, h: 24, mr: 20 })}
          </a>
        </div>
        <div className="flex flex-row items-center mt-1 ml-[44px]">
          <img
            referrerPolicy="no-referrer"
            className="mr-2 w-[16px] h-[16px] rounded-full"
            src={result.image}
          ></img>
          <a
            target="_blank"
            className="text-[#2067F5]"
            rel="noopener noreferrer"
            href={`https://${result.domain}.slack.com/team/${result.userId}`}
          >
            <p className="text-left text-sm pt-1 text-[#464B53]">
              {result.name}
            </p>
          </a>
        </div>
        {result.text && <HighlightedText chunk_summary={result.text} />}
        {showDebugInfo && (result.matchfeatures || result.rankfeatures) && (
          <details className="mt-2 ml-[44px] text-xs">
            <summary className="text-gray-500 cursor-pointer">
              {`Debug Info: ${index} : ${result.relevance}`}
            </summary>
            <pre className="text-xs bg-gray-100 p-2 rounded overflow-auto max-h-60">
              {JSON.stringify(
                {
                  matchfeatures: result.matchfeatures,
                  rankfeatures: result.rankfeatures,
                  relevance: result.relevance,
                },
                null,
                2,
              )}
            </pre>
          </details>
        )}
      </div>
    )
  } else if (result.type === codeRustSchema) { // Use the imported schema name
    // --- CodeMirror Rendering Logic ---
    content = (
      <div className={`flex flex-col mt-[28px] ${commonClassVals}`} key={index}>
        <div className="flex items-center justify-start space-x-2">
          <Code className="w-[24px] h-[24px] mr-[20px] flex-shrink-0" />
          <span className="font-medium">{result.filename}</span>
          <span className="text-sm text-gray-500 truncate">{result.path}</span>
        </div>
        {result.chunks_summary &&
          result.chunks_summary?.length > 0 &&
          result.chunks_summary.map((summary, idx) => {
            // Pass the original chunk with <hi> tags to CodeMirror
            // The plugin will handle finding <hi> and applying bold decoration
            // The editor itself will not display the <hi> tags
            return (
              <div
                key={idx}
                className="code-snippet-container ml-[44px] mt-1 border rounded" // Added margin, border, rounded for visual separation
                style={{
                  maxHeight: '150px', // Keep existing max height
                  overflowY: 'auto',  // Enable scrolling for long snippets
                  // Removed padding, let CodeMirror handle internal padding/styling
                }}
              >
                <CodeMirror
                  value={summary.chunk} // Pass original chunk with <hi> tags
                  extensions={[rust(), boldHiTextPlugin, rosePineDawn]} // Add bold plugin
                  // theme="dark" // Use a built-in or custom theme
                  basicSetup={{ // Minimal setup
                    lineNumbers: false,
                    foldGutter: false,
                    highlightActiveLine: false,
                    highlightSelectionMatches: false,
                    drawSelection: false,
                    indentOnInput: false,
                    syntaxHighlighting: true,
                    bracketMatching: false,
                    closeBrackets: false,
                    autocompletion: false,
                    rectangularSelection: false,
                    crosshairCursor: false,
                    highlightActiveLineGutter: false,
                    dropCursor: false,
                    tabSize: 2,
                  }}
                  readOnly={true}
                  style={{
                    fontSize: '0.875rem', // Match text-sm
                    maxWidth: '100%', // Prevent overlap
                    height: '100%', // Allow CodeMirror to fill the container height
                  }}
                />
              </div>
            );
          })}
        {/* Debug Info Display */}
        {showDebugInfo && (result.matchfeatures || result.rankfeatures) && (
          <details className="mt-2 ml-[44px] text-xs">
            <summary className="text-gray-500 cursor-pointer">
              {`Debug Info: ${index} : ${result.relevance}`}
            </summary>
            <pre className="text-xs bg-gray-100 p-2 rounded overflow-auto max-h-60">
              {JSON.stringify(
                {
                  matchfeatures: result.matchfeatures,
                  rankfeatures: result.rankfeatures,
                  relevance: result.relevance,
                },
                null,
                2,
              )}
            </pre>
          </details>
        )}
      </div>
    );
  }

  // Return the content for the specific result type
  return content;
};
