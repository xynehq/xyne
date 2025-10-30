import type { Context } from "hono"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import { HTTPException } from "hono/http-exception"
import { getErrorMessage } from "@/utils"
import { ScriptLanguage, getCodeWritingBlock } from "@/workflowScriptExecutorTool"

const loggerWithChild = getLoggerWithChild(Subsystem.Api, { module: "script" })

export const GetScriptLanguagesApi = async (c: Context) => {
  try {
    const availableLanguages = Object.values(ScriptLanguage)

    const languagesWithCodeBlocks = availableLanguages.map(language => {
      const codeWritingBlock = getCodeWritingBlock(language, {}, {})

      return {
        language,
        codeWritingBlock
      }
    })

    return c.json({
      availableLanguages: languagesWithCodeBlocks,
      totalCount: availableLanguages.length
    })
  } catch (error) {
    loggerWithChild().error(error, "Failed to get script languages")
    throw new HTTPException(500, {
      message: getErrorMessage(error),
    })
  }
}

