import React, { useEffect, useState } from "react";
import Papa from "papaparse";

interface CsvViewerProps {
  source: File;
  className?: string;
  style?: React.CSSProperties;
}

const CsvViewer: React.FC<CsvViewerProps> = ({ source, className }) => {
  const [data, setData] = useState<string[][]>([]);

  useEffect(() => {
    const reader = new FileReader();

    reader.onload = (e) => {
      const text = e.target?.result;
      if (!text || typeof text !== "string") return;

      Papa.parse(text, {
        complete: (results) => {
          setData(results.data as string[][]);
        },
        error: (err:any) => {
          console.error("CSV parsing error:", err);
        },
      });
    };

    reader.readAsText(source);
  }, [source]);

  if (data.length === 0) return <div className="p-4">Loading CSV file...</div>;

  return (
    <div className={`overflow-auto ${className}`}>
      <table className="min-w-full border border-gray-300">
        <tbody>
          {data.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  className="border border-gray-300 px-2 py-1 text-sm"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default CsvViewer;
