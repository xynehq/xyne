import * as XLSX from 'xlsx';

export interface ExcelSheet {
  name: string;
  data: any[][];
  columns: string[];
}

export interface ExcelFile {
  sheets: ExcelSheet[];
  hasMultipleSheets: boolean;
}

export class ExcelProcessor {
  static async processFile(file: File): Promise<ExcelFile> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target?.result as ArrayBuffer);
          const workbook = XLSX.read(data, { type: 'array' });
          
          const sheets: ExcelSheet[] = workbook.SheetNames.map(sheetName => {
            const worksheet = workbook.Sheets[sheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];
            
            // Extract column headers from first row
            const columns = jsonData.length > 0 ? jsonData[0].map((col, index) => 
              col || `Column ${index + 1}`
            ) : [];
            
            return {
              name: sheetName,
              data: jsonData,
              columns
            };
          });
          
          resolve({
            sheets,
            hasMultipleSheets: sheets.length > 1
          });
        } catch (error) {
          reject(new Error(`Failed to process Excel file: ${error instanceof Error ? error.message : 'Unknown error'}`));
        }
      };
      
      reader.onerror = () => {
        reject(new Error('Failed to read file'));
      };
      
      reader.readAsArrayBuffer(file);
    });
  }
  
  static getQuestionsFromSheet(sheet: ExcelSheet, columnIndex: number): string[] {
    if (columnIndex < 0 || columnIndex >= sheet.columns.length) {
      return [];
    }
    
    // Skip header row (index 0) and extract questions from specified column
    return sheet.data
      .slice(1)
      .map(row => row[columnIndex])
      .filter(cell => cell && typeof cell === 'string' && cell.trim().length > 0)
      .map(cell => cell.toString().trim());
  }
  
  static addAnswersToSheet(sheet: ExcelSheet, questionColumnIndex: number, answers: string[]): any[][] {
    const newData = [...sheet.data];
    
    // Add "Answers" header to the column next to questions
    const answerColumnIndex = questionColumnIndex + 1;
    
    if (newData.length > 0) {
      // Extend header row if needed
      while (newData[0].length <= answerColumnIndex) {
        newData[0].push('');
      }
      newData[0][answerColumnIndex] = 'Answers';
      
      // Add answers to subsequent rows
      for (let i = 1; i < newData.length && i - 1 < answers.length; i++) {
        while (newData[i].length <= answerColumnIndex) {
          newData[i].push('');
        }
        newData[i][answerColumnIndex] = answers[i - 1];
      }
    }
    
    return newData;
  }
  
  static exportToExcel(sheetData: any[][], filename: string): void {
    const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Q&A Results');
    XLSX.writeFile(workbook, `${filename}_with_answers.xlsx`);
  }
}