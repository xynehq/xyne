import { Parser } from "node-sql-parser";
import { getLogger } from "@/logger";
import { Subsystem } from "@/types";

const Logger = getLogger(Subsystem.Integrations).child({
  module: "sqlValidator",
});

export interface SQLValidationResult {
  isValid: boolean;
  sanitizedSQL?: string;
  error?: string;
  warnings?: string[];
}

export interface SQLValidationOptions {
  allowedViewName: string;
  allowSubqueries?: boolean;
  allowJoins?: boolean;
  allowWindowFunctions?: boolean;
  allowCTEs?: boolean;
}

/**
 * Comprehensive SQL validator using AST parsing for security and correctness
 */
export class SQLValidator {
  private parser: Parser;
  private options: SQLValidationOptions;

  constructor(options: SQLValidationOptions) {
    this.parser = new Parser();
    this.options = {
      allowSubqueries: true,
      allowJoins: false,
      allowWindowFunctions: true,
      allowCTEs: true,
      ...options,
    };
  }

  /**
   * Validates and sanitizes SQL query using AST analysis
   */
  public validateSQL(sql: string): SQLValidationResult {
    try {
      Logger.debug(`Validating SQL: ${sql}`);

      // Parse SQL into AST
      const ast = this.parseSQL(sql);
      if (!ast) {
        return {
          isValid: false,
          error: "Failed to parse SQL syntax",
        };
      }

      // Check for multiple statements
      if (Array.isArray(ast)) {
        return {
          isValid: false,
          error: "Multiple statements not allowed",
        };
      }

      // Validate statement type
      const statementTypeValidation = this.validateStatementType(ast);
      if (!statementTypeValidation.isValid) {
        return statementTypeValidation;
      }

      // Validate table access
      const tableValidation = this.validateTableAccess(sql);
      if (!tableValidation.isValid) {
        return tableValidation;
      }

      // Validate query structure
      const structureValidation = this.validateQueryStructure(ast);
      if (!structureValidation.isValid) {
        return structureValidation;
      }

      Logger.debug(`SQL validation successful: ${sql}`);
      return {
        isValid: true,
        sanitizedSQL: sql,
        warnings: this.collectWarnings(ast),
      };
    } catch (error) {
      Logger.error("SQL validation error:", error);
      return {
        isValid: false,
        error: `Validation error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private parseSQL(sql: string): any {
    try {
      return this.parser.astify(sql);
    } catch (error) {
      Logger.error("SQL parsing failed:", error);
      return null;
    }
  }

  private validateStatementType(ast: any): SQLValidationResult {
    const allowedTypes = ["select", "with"];
    
    if (!allowedTypes.includes(ast.type?.toLowerCase())) {
      return {
        isValid: false,
        error: `Statement type '${ast.type}' is not allowed. Only SELECT and WITH statements are permitted.`,
      };
    }

    return { isValid: true };
  }

  private validateTableAccess(sql: string): SQLValidationResult {
    try {
      const tableList = this.parser.tableList(sql);
      Logger.debug("Raw table list:", tableList);
      const allowedViewName = this.options.allowedViewName.toLowerCase();
      
      for (const table of tableList) {
        // Extract the actual table name from the complex string format
        const tableName = this.extractTableNameFromString(table);
        Logger.debug(`Extracted table name: "${tableName}" from "${table}"`);
        
        if (tableName && tableName.toLowerCase() !== allowedViewName) {
          return {
            isValid: false,
            error: `Access to table '${tableName}' is not allowed. Only '${this.options.allowedViewName}' is permitted.`,
          };
        }
      }

      return { isValid: true };
    } catch (error) {
      Logger.error("Table access validation failed:", error);
      return {
        isValid: false,
        error: "Failed to validate table access",
      };
    }
  }

  private extractTableNameFromString(tableString: string): string | null {
    if (!tableString) return null;
    
    // Handle the format "select::null::table_name" or similar
    const parts = tableString.split('::');
    if (parts.length >= 3) {
      // Return the last part which should be the actual table name
      return parts[parts.length - 1];
    }
    
    // If it's a simple table name, return as is
    return tableString;
  }

  private validateQueryStructure(ast: any): SQLValidationResult {
    const warnings: string[] = [];

    // Check for subqueries
    if (this.hasSubqueries(ast) && !this.options.allowSubqueries) {
      return {
        isValid: false,
        error: "Subqueries are not allowed",
      };
    }

    // Check for joins
    if (this.hasJoins(ast) && !this.options.allowJoins) {
      return {
        isValid: false,
        error: "Joins are not allowed",
      };
    }

    // Check for window functions
    if (this.hasWindowFunctions(ast) && !this.options.allowWindowFunctions) {
      return {
        isValid: false,
        error: "Window functions are not allowed",
      };
    }

    // Check for CTEs
    if (ast.type === "with" && !this.options.allowCTEs) {
      return {
        isValid: false,
        error: "Common Table Expressions (CTEs) are not allowed",
      };
    }

    return { isValid: true, warnings };
  }

  private hasSubqueries(ast: any): boolean {
    if (!ast) return false;
    
    // Check if any FROM clause contains a subquery
    if (ast.from) {
      for (const fromItem of Array.isArray(ast.from) ? ast.from : [ast.from]) {
        if (fromItem.expr && fromItem.expr.type === "select") {
          return true;
        }
      }
    }

    // Check WHERE clause for subqueries
    if (ast.where && this.hasSubqueryInExpression(ast.where)) {
      return true;
    }

    // Check HAVING clause for subqueries
    if (ast.having && this.hasSubqueryInExpression(ast.having)) {
      return true;
    }

    return false;
  }

  private hasSubqueryInExpression(expr: any): boolean {
    if (!expr) return false;
    
    if (expr.type === "select") return true;
    
    if (expr.left && this.hasSubqueryInExpression(expr.left)) return true;
    if (expr.right && this.hasSubqueryInExpression(expr.right)) return true;
    if (expr.operand && this.hasSubqueryInExpression(expr.operand)) return true;
    
    return false;
  }

  private hasJoins(ast: any): boolean {
    if (!ast || !ast.from) return false;
    
    const fromItems = Array.isArray(ast.from) ? ast.from : [ast.from];
    return fromItems.some((item: any) => item.join);
  }

  private hasWindowFunctions(ast: any): boolean {
    if (!ast) return false;
    
    // Check SELECT columns for window functions
    if (ast.columns) {
      for (const column of ast.columns) {
        if (this.hasWindowFunctionInExpression(column)) {
          return true;
        }
      }
    }
    
    return false;
  }

  private hasWindowFunctionInExpression(expr: any): boolean {
    if (!expr) return false;
    
    if (expr.type === "function" && expr.over) {
      return true;
    }
    
    if (expr.left && this.hasWindowFunctionInExpression(expr.left)) return true;
    if (expr.right && this.hasWindowFunctionInExpression(expr.right)) return true;
    if (expr.operand && this.hasWindowFunctionInExpression(expr.operand)) return true;
    
    return false;
  }

  private astToSQL(ast: any): string | null {
    try {
      // Convert AST back to SQL without any modifications
      return this.parser.sqlify(ast);
    } catch (error) {
      Logger.error("Failed to convert AST to SQL:", error);
      return null;
    }
  }

  private collectWarnings(ast: any): string[] {
    const warnings: string[] = [];
    
    // Check for potential performance issues
    if (this.hasSubqueries(ast)) {
      warnings.push("Query contains subqueries which may impact performance");
    }
    
    if (this.hasJoins(ast)) {
      warnings.push("Query contains joins which may impact performance");
    }
    
    if (this.hasWindowFunctions(ast)) {
      warnings.push("Query contains window functions which may impact performance");
    }

    return warnings;
  }
}

/**
 * Convenience function to validate SQL with default options
 */
export function validateSQLQuery(
  sql: string,
  allowedViewName: string,
  options?: Partial<SQLValidationOptions>
): SQLValidationResult {
  const validator = new SQLValidator({
    allowedViewName,
    ...options,
  });
  
  return validator.validateSQL(sql);
}
