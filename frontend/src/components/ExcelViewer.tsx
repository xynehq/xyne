import { DocumentOperations } from "@/contexts/DocumentOperationsContext";
import React, { useEffect, useState } from "react";
import * as XLSX from "xlsx";

interface ExcelViewerProps {
  source: File;
  className?: string;
  style?: React.CSSProperties;
  documentOperationsRef?: React.RefObject<DocumentOperations>;
  onSheetChange?: (sheetIndex: number) => void;
}

const ExcelViewer: React.FC<ExcelViewerProps> = ({ source, className, documentOperationsRef, onSheetChange }) => {
  const [sheets, setSheets] = useState<{ name: string; data: any[][] }[]>([]);
  const [activeSheet, setActiveSheet] = useState(0);

  useEffect(() => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const arrayBuffer = e.target?.result;
      if (!arrayBuffer) return;

      const workbook = XLSX.read(arrayBuffer, { 
        type: "array",
        cellDates: true,   // dates come back as JS Date objects
        cellNF: true       // keep the original number format in cell.z
      });

      const parsedSheets = workbook.SheetNames.map((sheetName) => {
        const worksheet = workbook.Sheets[sheetName];
        // Get the range of the worksheet to preserve empty cells
        const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1');
        const sheetData: any[][] = [];
        
        // Initialize the array with the correct dimensions
        for (let row = range.s.r; row <= range.e.r; row++) {
          const rowData: any[] = [];
          for (let col = range.s.c; col <= range.e.c; col++) {
            const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
            const cell = worksheet[cellAddress];
            rowData.push(cell ? XLSX.utils.format_cell(cell) : "");
          }
          sheetData.push(rowData);
        }
        
        return { name: sheetName, data: sheetData };
      });

      setSheets(parsedSheets);
      setActiveSheet(0);
    };

    reader.readAsArrayBuffer(source);
  }, [source]);

  // Register the goToPage function with the DocumentOperations ref
  useEffect(() => {
    if (documentOperationsRef?.current) {
      documentOperationsRef.current.goToPage = async (sheetIndex?: number) => {
        if (sheetIndex !== undefined) {
          if (sheetIndex >= 0 && sheetIndex < sheets.length) {
            setActiveSheet(sheetIndex)
          }
        }
      }
    }
    
    // Cleanup function to remove the goToPage function when component unmounts
    return () => {
      if (documentOperationsRef?.current) {
        documentOperationsRef.current.goToPage = undefined
      }
    }
  }, [documentOperationsRef, setActiveSheet, sheets])

  // Notify parent component when sheet changes
  useEffect(() => {
    if (onSheetChange) {
      onSheetChange(activeSheet)
    }
  }, [activeSheet, onSheetChange])

  if (sheets.length === 0) {
    return <div className="p-4">Loading Excel file...</div>;
  }

  const currentSheet = sheets[activeSheet];

  return (
    <div className={`overflow-auto ${className}`}>
      {/* Sheet selector */}
      <div className="flex space-x-2 mb-2">
        {sheets.map((sheet, idx) => (
          <button
            key={sheet.name}
            onClick={() => setActiveSheet(idx)}
            className={`px-3 py-1 border rounded ${
              idx === activeSheet
                ? "bg-blue-500 text-white"
                : "bg-background text-foreground "
            }`}
          >
            {sheet.name}
          </button>
        ))}
      </div>

      {/* Table view */}
      <table className="min-w-full border border-gray-300">
        <tbody>
          {currentSheet.data.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td
                  key={j}
                  className="border border-gray-300 px-2 py-1 text-sm"
                >
                  {cell?.toString() ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default ExcelViewer;
