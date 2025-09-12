import { db } from "./client"
import {
  userPersonalization,
  users,
  type InsertPersonalization,
  type SelectPersonalization,
  insertPersonalizationSchema,
  selectPersonalizationSchema,
} from "@/db/schema"
import { eq, sql } from "drizzle-orm"
import { type TxnOrClient } from "@/types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { SearchModes } from "@xyne/vespa-ts/types"

const Logger = getLogger(Subsystem.Db).child({ module: "personalization" })

/**
 * Upserts personalization settings for a user.
 * If settings exist for the userId, it merges the new parameters into the existing JSON;
 * otherwise, it inserts a new record with the provided parameters.
 * @param trx - Drizzle transaction or client
 * @param userId - The ID of the user
 * @param email - The email of the user
 * @param workspaceId - The ID of the workspace
 * @param newData - The new personalization data to merge/insert (e.g., { NativeRank: { alpha: 60 } })
 * @returns The inserted or updated personalization settings
 */
export const upsertUserPersonalization = async (
  trx: TxnOrClient,
  userId: number,
  email: string,
  workspaceId: number,
  newData: SelectPersonalization["parameters"],
): Promise<SelectPersonalization> => {
  Logger.debug(
    { userId, email, workspaceId, newData },
    "Upserting user personalization",
  )

  // Validate the input data structure using the parameters schema
  const parsedNewData =
    insertPersonalizationSchema.shape.parameters.safeParse(newData)
  if (!parsedNewData.success) {
    const errorMsg = `Invalid newData format for upsert: ${parsedNewData.error.toString()}`
    Logger.error({ userId, newData, error: parsedNewData.error }, errorMsg)
    throw new Error(errorMsg)
  }

  try {
    // Use insert with onConflictDoUpdate to handle both insert and update
    const result = await trx
      .insert(userPersonalization)
      .values({
        userId,
        email,
        workspaceId,
        parameters: parsedNewData.data, // Initial values for insert
      })
      .onConflictDoUpdate({
        target: userPersonalization.userId, // Conflict on the unique userId
        set: {
          parameters: parsedNewData.data, // Override parameters on update
          // email and workspaceId don't need updating if they match the target userId
          updatedAt: sql`NOW()`, // Always update the timestamp
        },
      })
      .returning()

    if (!result || result.length === 0) {
      throw new Error("Upsert operation failed to return the record.")
    }
    Logger.info({ userId }, "Successfully upserted user personalization")

    // Parse the returned record before sending it back to ensure type safety
    const parsedResult = selectPersonalizationSchema.parse(result[0])
    return parsedResult
  } catch (error) {
    Logger.error(
      error,
      `Error upserting personalization for userId ${userId}: ${error instanceof Error ? error.message : error}`,
    )
    throw error // Re-throw the error after logging
  }
}

/**
 * Retrieves personalization settings for a given user.
 * @param trx - Drizzle transaction or client
 * @param userId - The ID of the user
 * @returns The personalization settings object or null if not found
 */
export const getUserPersonalization = async (
  trx: TxnOrClient,
  userId: number,
): Promise<SelectPersonalization | null> => {
  Logger.debug({ userId }, "Getting user personalization")
  try {
    const result = await trx
      .select()
      .from(userPersonalization)
      .where(eq(userPersonalization.userId, userId))
      .limit(1)

    if (result.length === 0) {
      Logger.warn({ userId }, "No personalization settings found for user")
      return null
    }
    // Validate the result against the select schema before returning
    const parsedResult = selectPersonalizationSchema.safeParse(result[0])
    if (!parsedResult.success) {
      Logger.error(
        {
          userId,
          error: parsedResult.error,
          rawData: result[0],
        },
        `Database data for userId ${userId} failed personalization schema validation.`,
      )
      // Depending on strictness, you might return null or throw an error
      return null // Return null if data is invalid
    }
    return parsedResult.data
  } catch (error) {
    Logger.error(
      error,
      `Error getting personalization for userId ${userId}: ${error instanceof Error ? error.message : error}`,
    )
    throw error // Re-throw the error after logging
  }
}

/**
 * Retrieves personalization settings for a given user email.
 * @param trx - Drizzle transaction or client
 * @param email - The email of the user
 * @returns The personalization settings object or null if not found
 */
export const getUserPersonalizationByEmail = async (
  trx: TxnOrClient,
  email: string,
): Promise<SelectPersonalization | null> => {
  Logger.debug({ email }, "Getting user personalization by email")
  try {
    const result = await trx
      .select()
      .from(userPersonalization)
      .where(eq(userPersonalization.email, email.toLowerCase())) // Use lowercase email for lookup
      .limit(1)

    if (result.length === 0) {
      Logger.warn({ email }, "No personalization settings found for user email")
      return null
    }
    // Validate the result against the select schema before returning
    const parsedResult = selectPersonalizationSchema.safeParse(result[0])
    if (!parsedResult.success) {
      Logger.error(
        {
          email,
          error: parsedResult.error,
          rawData: result[0],
        },
        `Database data for user email ${email} failed personalization schema validation.`,
      )
      // Depending on strictness, you might return null or throw an error
      return null // Return null if data is invalid
    }
    return parsedResult.data
  } catch (error) {
    Logger.error(
      error,
      `Error getting personalization for user email ${email}: ${error instanceof Error ? error.message : error}`,
    )
    throw error // Re-throw the error after logging
  }
}

/**
 * Retrieves the personalized alpha value for NativeRank search mode for a given user email.
 * Defaults to 0.5 if personalization is not found or alpha is not set.
 * @param trx - Drizzle transaction or client
 * @param email - The email of the user
 * @param defaultAlpha - The default alpha value to return if personalization is not found (defaults to 0.5)
 * @returns The personalized alpha value or the default value.
 */
export const getUserPersonalizationAlpha = async (
  trx: TxnOrClient,
  email: string,
  defaultAlpha: number = 0.5,
): Promise<number> => {
  const callerFunctionName =
    new Error().stack?.split("\n")[2].trim() || "unknown"
  Logger.debug({ email, defaultAlpha }, "Getting personalized alpha for user")
  let userAlpha = defaultAlpha
  try {
    const personalization = await getUserPersonalizationByEmail(trx, email)
    if (personalization) {
      const nativeRankParams =
        personalization.parameters?.[SearchModes.NativeRank]
      if (nativeRankParams?.alpha !== undefined) {
        userAlpha = nativeRankParams.alpha
        Logger.info(
          { email, alpha: userAlpha, calledFrom: callerFunctionName },
          `Using personalized alpha (${userAlpha})`, // Simplified message
        )
      } else {
        Logger.info(
          { email, calledFrom: callerFunctionName },
          `No personalized alpha found in settings, using default (${defaultAlpha})`,
        )
      }
    } else {
      Logger.warn(
        { email, calledFrom: callerFunctionName },
        `User personalization settings not found, using default alpha (${defaultAlpha})`,
      )
    }
  } catch (err) {
    Logger.error(
      err,
      `Failed to fetch personalization, using default alpha (${defaultAlpha})`,
      { email, calledFrom: callerFunctionName },
    )
  }
  return userAlpha
}
