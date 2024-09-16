import React from 'react';

const parseHighlight = (text) => {
    if (!text) return null;
  
    // Split the text on <hi> and </hi>, including the tags in the result
    const parts = text.split(/(<hi>|<\/hi>)/);
  
    let isHighlight = false;
    const segments = [];
  
    parts.forEach((part) => {
      if (part === '<hi>') {
        isHighlight = true;
      } else if (part === '</hi>') {
        isHighlight = false;
      } else if (part) {
        segments.push({ text: part, highlight: isHighlight });
      }
    });
  
    return segments.map((segment, index) =>
      segment.highlight ? (
        <span key={index} className="font-bold">
          {segment.text}
        </span>
      ) : (
        <React.Fragment key={index}>{segment.text}</React.Fragment>
      )
    );
  };
  
  // Component that renders chunk summary with parsing
  const HighlightedText = ({ chunk_summary }) => (
    <p className="text-left text-sm mt-1 line-clamp-[2.5] text-ellipsis overflow-hidden">
      {chunk_summary ? parseHighlight(chunk_summary) : ' '}
    </p>
  );
  
  export default HighlightedText;