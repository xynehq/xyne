import { z } from "zod"
import config from "@/config"
import { HTTPException } from "hono/http-exception"
import type { Context } from "hono"
import { AccessToken, RoomServiceClient } from "livekit-server-sdk"
import { db } from "@/db/client"
import { getUserByEmail, getUsersByWorkspace } from "@/db/user"
import { callNotificationService } from "@/services/callNotifications"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { calls, callParticipants, callInvitedUsers, CallType } from "@/db/schema/calls"
import { eq, desc, and, isNull, or, sql, inArray } from "drizzle-orm"
import { randomUUID } from "node:crypto"

const { JwtPayloadKey } = config

const Logger = getLogger(Subsystem.Api).child({ module: "calls" })

// LiveKit configuration
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY!
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET!
const LIVEKIT_URL = process.env.LIVEKIT_URL || "ws://localhost:7880"
const LIVEKIT_CLIENT_URL = process.env.LIVEKIT_CLIENT_URL

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  throw new Error(
    "LiveKit API key and secret must be provided in environment variables",
  )
}

const roomService = new RoomServiceClient(
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
)

// Schemas
export const initiateCallSchema = z.object({
  targetUserId: z.string().min(1, "Target user ID is required"),
  callType: z.nativeEnum(CallType).default(CallType.Audio),
})

export const joinCallSchema = z.object({
  callId: z.string().uuid("Invalid call ID format"),
})

export const endCallSchema = z.object({
  callId: z.string().uuid("Invalid call ID format"),
})

export const leaveCallSchema = z.object({
  callId: z.string().uuid("Invalid call ID format"),
})

export const inviteToCallSchema = z.object({
  callId: z.string().uuid("Invalid call ID format"),
  targetUserId: z.string().min(1, "Target user ID is required"),
  callType: z.nativeEnum(CallType).default(CallType.Audio),
})

// Generate LiveKit access token
// Note: LiveKit still uses the 'room' property, but we pass callId (externalId) as the room name
const generateAccessToken = async (
  userIdentity: string,
  callId: string,
  userName?: string,
): Promise<string> => {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: userIdentity,
    name: userName, // Add user's display name to token
    ttl: "10m", // Token valid for 10 minutes
  })

  at.addGrant({
    roomJoin: true,
    room: callId, // LiveKit room name is the callId (externalId)
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  })

  return await at.toJwt()
}

// Initiate a call between two users
export const InitiateCallApi = async (c: Context) => {
  try {
    const { workspaceId, sub: callerEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()
    const { targetUserId, callType } = requestBody

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = initiateCallSchema.parse({ targetUserId, callType })

    // Get caller info
    const callerUsers = await getUserByEmail(db, callerEmail)
    if (!callerUsers || callerUsers.length === 0) {
      throw new HTTPException(404, { message: "Caller not found" })
    }
    const caller = callerUsers[0]

    // Check if caller is trying to call themselves before making DB queries
    if (caller.externalId === validatedData.targetUserId) {
      throw new HTTPException(400, { message: "Cannot call yourself" })
    }

    // Get target user directly with external ID filter (scoped to current workspace)
    const targetUsers = await getUsersByWorkspace(
      db,
      workspaceId,
      validatedData.targetUserId,
    )
    const targetUser = targetUsers[0]

    if (!targetUser) {
      throw new HTTPException(404, { message: "Target user not found" })
    }

    // Generate unique call ID (this will also be the LiveKit room name)
    const callExternalId = randomUUID()
    // Store shareable link with call type (no token - tokens are generated per user when they join)
    const roomLink = `${LIVEKIT_CLIENT_URL || "http://localhost:5173"}/call?callId=${callExternalId}&type=${validatedData.callType}`

    // Create room in LiveKit using externalId as room name
    await roomService.createRoom({
      name: callExternalId,
      maxParticipants: 30, // Allow more participants for group calls
      emptyTimeout: 300, // Room closes after 5 minutes if empty
    })

    // Save call record to database
    // Note: Don't add caller to participants yet - they need to actually join first
    const [newCall] = await db
      .insert(calls)
      .values({
        externalId: callExternalId,
        createdByUserId: caller.id,
        roomLink,
        callType: validatedData.callType,
      })
      .returning()

    // Add target user to invited users junction table
    await db.insert(callInvitedUsers).values({
      callId: newCall.id,
      userId: targetUser.id,
    })

    // Generate access tokens for both users
    const callerToken = await generateAccessToken(
      caller.externalId,
      callExternalId,
      caller.name,
    )
    const targetToken = await generateAccessToken(
      targetUser.externalId,
      callExternalId,
      targetUser.name,
    )

    // Send real-time notification to target user
    const callNotification = {
      type: "incoming_call" as const,
      callId: callExternalId,
      caller: {
        id: caller.externalId,
        name: caller.name,
        email: caller.email,
        photoLink: caller.photoLink,
      },
      target: {
        id: targetUser.externalId,
        name: targetUser.name,
        email: targetUser.email,
        photoLink: targetUser.photoLink,
      },
      callType: validatedData.callType,
      targetToken,
      livekitUrl: LIVEKIT_CLIENT_URL,
      timestamp: Date.now(),
    }

    // Send notification via WebSocket
    const notificationSent =
      callNotificationService.sendCallInvitation(callNotification)

    Logger.info(`Call initiated by ${caller.name} to ${targetUser.name}`)
    Logger.info(`Real-time notification sent: ${notificationSent}`)

    return c.json({
      success: true,
      callId: callExternalId,
      callerToken,
      callType: validatedData.callType,
      livekitUrl: LIVEKIT_CLIENT_URL,
      notificationSent, // Include whether notification was sent
      caller: {
        id: caller.externalId,
        name: caller.name,
        email: caller.email,
        photoLink: caller.photoLink,
      },
      target: {
        id: targetUser.externalId,
        name: targetUser.name,
        email: targetUser.email,
        photoLink: targetUser.photoLink,
      },
    })
  } catch (error) {
    Logger.error(error, "Error initiating call")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to initiate call" })
  }
}

// Join an existing call
export const JoinCallApi = async (c: Context) => {
  try {
    const { sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()
    const { callId } = requestBody

    // Validate input
    const validatedData = joinCallSchema.parse({ callId })

    // Get user info
    const users = await getUserByEmail(db, userEmail)
    if (!users || users.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const user = users[0]

    // Check if room exists in LiveKit (room name is the callId/externalId)
    const rooms = await roomService.listRooms([validatedData.callId])
    if (!rooms || rooms.length === 0) {
      throw new HTTPException(404, { message: "Call room not found" })
    }

    // Get the call record to get the call ID
    const callRecords = await db
      .select()
      .from(calls)
      .where(eq(calls.externalId, validatedData.callId))
      .limit(1)

    if (callRecords.length === 0) {
      throw new HTTPException(404, { message: "Call not found" })
    }

    const callRecord = callRecords[0]

    // Add user to participants junction table if not already present
    // Use onConflictDoNothing to prevent duplicate entries
    await db
      .insert(callParticipants)
      .values({
        callId: callRecord.id,
        userId: user.id,
      })
      .onConflictDoNothing()

    // Generate access token (room name in LiveKit is the callId)
    const token = await generateAccessToken(
      user.externalId,
      validatedData.callId,
      user.name,
    )

    return c.json({
      success: true,
      token,
      callId: validatedData.callId,
      livekitUrl: LIVEKIT_CLIENT_URL,
      user: {
        id: user.externalId,
        name: user.name,
        email: user.email,
        photoLink: user.photoLink,
      },
    })
  } catch (error) {
    Logger.error(error, "Error joining call")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to join call" })
  }
}

// Invite a user to an existing call
export const InviteToCallApi = async (c: Context) => {
  try {
    const { workspaceId, sub: inviterEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()
    const { callId, targetUserId, callType } = requestBody

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = inviteToCallSchema.parse({
      callId,
      targetUserId,
      callType,
    })

    // Get inviter info
    const inviterUsers = await getUserByEmail(db, inviterEmail)
    if (!inviterUsers || inviterUsers.length === 0) {
      throw new HTTPException(404, { message: "Inviter not found" })
    }
    const inviter = inviterUsers[0]

    // Check if inviter is trying to invite themselves before making DB queries
    if (inviter.externalId === validatedData.targetUserId) {
      throw new HTTPException(400, { message: "Cannot invite yourself" })
    }

    // Get target user directly with external ID filter (scoped to current workspace)
    const targetUsers = await getUsersByWorkspace(
      db,
      workspaceId,
      validatedData.targetUserId,
    )
    const targetUser = targetUsers[0]

    if (!targetUser) {
      throw new HTTPException(404, { message: "Target user not found" })
    }

    // Check if room exists in LiveKit (room name is the callId)
    try {
      const room = await roomService.listRooms([validatedData.callId])
      if (!room || room.length === 0) {
        throw new HTTPException(404, { message: "Call room not found" })
      }
    } catch (error) {
      throw new HTTPException(404, { message: "Call room not found" })
    }

    // Authorization: only creator or participant can invite
    const rows = await db
      .select()
      .from(calls)
      .where(eq(calls.externalId, validatedData.callId))
      .limit(1)
    if (rows.length === 0)
      throw new HTTPException(404, { message: "Call not found" })
    const rec = rows[0]
    const isCreator = rec.createdByUserId === inviter.id

    // Check if inviter is a participant
    const participantCheck = await db
      .select()
      .from(callParticipants)
      .where(
        and(
          eq(callParticipants.callId, rec.id),
          eq(callParticipants.userId, inviter.id),
        ),
      )
      .limit(1)
    const isParticipant = participantCheck.length > 0

    if (!isCreator && !isParticipant) {
      throw new HTTPException(403, {
        message: "Not authorized to invite to this call",
      })
    }

    // Add invited user to junction table if not already present
    // Use onConflictDoNothing to prevent duplicate entries
    await db
      .insert(callInvitedUsers)
      .values({
        callId: rec.id,
        userId: targetUser.id,
      })
      .onConflictDoNothing()

    // Generate access token for the invited user (room name in LiveKit is the callId)
    const targetToken = await generateAccessToken(
      targetUser.externalId,
      validatedData.callId,
      targetUser.name,
    )

    // Send real-time notification to target user
    const callNotification = {
      type: "incoming_call" as const,
      callId: validatedData.callId,
      caller: {
        id: inviter.externalId,
        name: inviter.name,
        email: inviter.email,
        photoLink: inviter.photoLink,
      },
      target: {
        id: targetUser.externalId,
        name: targetUser.name,
        email: targetUser.email,
        photoLink: targetUser.photoLink,
      },
      callType: validatedData.callType,
      targetToken,
      livekitUrl: LIVEKIT_CLIENT_URL,
      timestamp: Date.now(),
    }

    // Send notification via WebSocket
    const notificationSent =
      callNotificationService.sendCallInvitation(callNotification)

    Logger.info(
      `User ${inviter.name} invited ${targetUser.name} to call ${validatedData.callId}`,
    )
    Logger.info(`Real-time notification sent: ${notificationSent}`)

    return c.json({
      success: true,
      callId: validatedData.callId,
      callType: validatedData.callType,
      notificationSent,
      inviter: {
        id: inviter.externalId,
        name: inviter.name,
        email: inviter.email,
        photoLink: inviter.photoLink,
      },
      target: {
        id: targetUser.externalId,
        name: targetUser.name,
        email: targetUser.email,
        photoLink: targetUser.photoLink,
      },
    })
  } catch (error) {
    Logger.error(error, "Error inviting user to call")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to invite user to call" })
  }
}

// End a call
export const EndCallApi = async (c: Context) => {
  try {
    const { sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()
    const { callId } = requestBody

    // Validate input
    const validatedData = endCallSchema.parse({ callId })

    // Get user info
    const users = await getUserByEmail(db, userEmail)
    if (!users || users.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const user = users[0]

    // Authorization: only creator or participant can end
    const rows = await db
      .select()
      .from(calls)
      .where(eq(calls.externalId, validatedData.callId))
      .limit(1)
    if (rows.length === 0)
      throw new HTTPException(404, { message: "Call not found" })
    const rec = rows[0]
    const isCreator = rec.createdByUserId === user.id

    // Check if user is a participant
    const participantCheck = await db
      .select()
      .from(callParticipants)
      .where(
        and(
          eq(callParticipants.callId, rec.id),
          eq(callParticipants.userId, user.id),
        ),
      )
      .limit(1)
    const isParticipant = participantCheck.length > 0

    if (!isCreator && !isParticipant) {
      throw new HTTPException(403, {
        message: "Not authorized to end this call",
      })
    }

    // Update call record - set endedAt timestamp
    await db
      .update(calls)
      .set({
        endedAt: new Date(),
      })
      .where(eq(calls.externalId, validatedData.callId))

    // Delete the room from LiveKit (room name is the callId)
    await roomService.deleteRoom(validatedData.callId)

    return c.json({
      success: true,
      message: "Call ended successfully",
    })
  } catch (error) {
    Logger.error(error, "Error ending call")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to end call" })
  }
}

// Leave a call (called when a participant disconnects)
export const LeaveCallApi = async (c: Context) => {
  try {
    const { sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()
    const { callId } = requestBody

    // Validate input
    const validatedData = leaveCallSchema.parse({ callId })

    // Get user info
    const users = await getUserByEmail(db, userEmail)
    if (!users || users.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const user = users[0]

    Logger.info(
      `User ${user.email} (${user.externalId}) leaving call ${validatedData.callId}`,
    )

    // Verify user belongs to this call
    const rows = await db
      .select()
      .from(calls)
      .where(eq(calls.externalId, validatedData.callId))
      .limit(1)
    if (rows.length === 0)
      throw new HTTPException(404, { message: "Call not found" })
    const rec = rows[0]

    // Check if user is creator, participant, or invited
    const isCreator = rec.createdByUserId === user.id

    const participantCheck = await db
      .select()
      .from(callParticipants)
      .where(
        and(
          eq(callParticipants.callId, rec.id),
          eq(callParticipants.userId, user.id),
        ),
      )
      .limit(1)
    const isParticipant = participantCheck.length > 0

    const invitedCheck = await db
      .select()
      .from(callInvitedUsers)
      .where(
        and(
          eq(callInvitedUsers.callId, rec.id),
          eq(callInvitedUsers.userId, user.id),
        ),
      )
      .limit(1)
    const isInvited = invitedCheck.length > 0

    const belongs = isCreator || isParticipant || isInvited
    if (!belongs)
      throw new HTTPException(403, {
        message: "Not authorized to leave this call",
      })

    // Update the participant record with leftAt timestamp if they are a participant
    if (isParticipant) {
      await db
        .update(callParticipants)
        .set({ leftAt: new Date() })
        .where(
          and(
            eq(callParticipants.callId, rec.id),
            eq(callParticipants.userId, user.id),
          ),
        )
    }

    // Check if room still exists in LiveKit (room name is the callId)
    let roomExists = true
    let participantCount = 0
    try {
      const rooms = await roomService.listRooms([validatedData.callId])
      if (rooms && rooms.length > 0) {
        participantCount = rooms[0].numParticipants
      } else {
        roomExists = false
      }
    } catch (error) {
      Logger.warn(`Room ${validatedData.callId} not found in LiveKit`)
      roomExists = false
    }

    // If room doesn't exist or has no participants, mark call as ended
    if (!roomExists || participantCount === 0) {
      Logger.info(
        `Room ${validatedData.callId} is empty or doesn't exist. Marking call as ended.`,
      )

      // Update call record - set endedAt timestamp only if not already set
      await db
        .update(calls)
        .set({
          endedAt: new Date(),
        })
        .where(
          and(
            eq(calls.externalId, validatedData.callId),
            isNull(calls.endedAt),
          ),
        )
    }

    return c.json({
      success: true,
      message: "Left call successfully",
      roomEmpty: !roomExists || participantCount === 0,
    })
  } catch (error) {
    Logger.error(error, "Error leaving call")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to leave call" })
  }
}

// Get active calls for a user
export const GetActiveCallsApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Get user info
    const users = await getUserByEmail(db, userEmail)
    if (!users || users.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const user = users[0]

    // List all rooms and filter by user participation
    const rooms = await roomService.listRooms()
    const userRooms = rooms.filter(
      (room) => room.name.includes(user.externalId) && room.numParticipants > 0,
    )

    return c.json({
      success: true,
      activeCalls: userRooms.map((room) => ({
        callId: room.name, // LiveKit room.name is our callId (externalId)
        participants: room.numParticipants,
        createdAt: room.creationTime,
      })),
    })
  } catch (error) {
    Logger.error(error, "Error getting active calls")
    throw new HTTPException(500, { message: "Failed to get active calls" })
  }
}

// Get call history for a user
export const GetCallHistoryApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Get query parameters for filtering
    const callType = c.req.query("callType") // 'video', 'audio', 'missed', or undefined
    const timeFilter = c.req.query("timeFilter") // 'today', 'week', 'month', or undefined
    const searchQuery = c.req.query("search") // search string or undefined

    // Get user info
    const users = await getUserByEmail(db, userEmail)
    if (!users || users.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const user = users[0]

    // Get all calls where user is creator
    const createdCalls = db
      .select({ callId: calls.id })
      .from(calls)
      .where(eq(calls.createdByUserId, user.id))

    // Get all calls where user is a participant
    const participatedCalls = db
      .select({ callId: callParticipants.callId })
      .from(callParticipants)
      .where(eq(callParticipants.userId, user.id))

    // Get all calls where user was invited
    const invitedCalls = db
      .select({ callId: callInvitedUsers.callId })
      .from(callInvitedUsers)
      .where(eq(callInvitedUsers.userId, user.id))

    // Combine all call IDs using UNION
    const userCallIds = await db
      .select({ callId: calls.id })
      .from(calls)
      .where(
        or(
          eq(calls.createdByUserId, user.id),
          inArray(
            calls.id,
            db
              .select({ callId: callParticipants.callId })
              .from(callParticipants)
              .where(eq(callParticipants.userId, user.id)),
          ),
          inArray(
            calls.id,
            db
              .select({ callId: callInvitedUsers.callId })
              .from(callInvitedUsers)
              .where(eq(callInvitedUsers.userId, user.id)),
          ),
        ),
      )

    const callIds = userCallIds.map((row) => row.callId)

    if (callIds.length === 0) {
      return c.json({
        success: true,
        calls: [],
      })
    }

    // Build filter conditions for the main query
    const conditions = [isNull(calls.deletedAt), inArray(calls.id, callIds)]

    // Handle missed calls filter
    if (callType === "missed") {
      // Missed calls: user was invited but didn't participate
      const missedCallIds = await db
        .select({ callId: callInvitedUsers.callId })
        .from(callInvitedUsers)
        .where(
          and(
            eq(callInvitedUsers.userId, user.id),
            sql`NOT EXISTS (
              SELECT 1 FROM ${callParticipants} 
              WHERE ${callParticipants.callId} = ${callInvitedUsers.callId} 
              AND ${callParticipants.userId} = ${user.id}
            )`,
          ),
        )

      const missedIds = missedCallIds.map((row) => row.callId)
      if (missedIds.length === 0) {
        return c.json({
          success: true,
          calls: [],
        })
      }
      conditions.push(inArray(calls.id, missedIds))
    } else if (callType === CallType.Video || callType === CallType.Audio) {
      // Filter by call type
      conditions.push(eq(calls.callType, callType))
    }

    // Filter by time
    if (timeFilter) {
      const now = new Date()
      let startDate: Date

      if (timeFilter === "today") {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      } else if (timeFilter === "week") {
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      } else if (timeFilter === "month") {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1)
      } else {
        startDate = new Date(0) // Beginning of time if invalid
      }

      conditions.push(sql`${calls.startedAt} >= ${startDate.toISOString()}`)
    }

    // Get all calls with the applied filters
    const callHistory = await db
      .select()
      .from(calls)
      .where(and(...conditions))
      .orderBy(desc(calls.startedAt))

    // Get workspace users to enrich the response with user details
    const workspaceUsers = await getUsersByWorkspace(db, workspaceId)
    const userIdMap = new Map(workspaceUsers.map((u) => [u.id, u]))

    // Get all participants and invited users for these calls
    const callIdsFromHistory = callHistory.map((call) => call.id)

    const participantsData = await db
      .select()
      .from(callParticipants)
      .where(inArray(callParticipants.callId, callIdsFromHistory))

    const invitedUsersData = await db
      .select()
      .from(callInvitedUsers)
      .where(inArray(callInvitedUsers.callId, callIdsFromHistory))

    // Create maps for efficient lookup
    const participantsByCall = new Map<number, number[]>()
    participantsData.forEach((p) => {
      if (!participantsByCall.has(p.callId)) {
        participantsByCall.set(p.callId, [])
      }
      participantsByCall.get(p.callId)!.push(p.userId)
    })

    const invitedUsersByCall = new Map<number, number[]>()
    invitedUsersData.forEach((i) => {
      if (!invitedUsersByCall.has(i.callId)) {
        invitedUsersByCall.set(i.callId, [])
      }
      invitedUsersByCall.get(i.callId)!.push(i.userId)
    })

    // Filter by search query (on enriched data)
    let filteredCalls = callHistory
    if (searchQuery && searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim()
      filteredCalls = callHistory.filter((call) => {
        const creator = userIdMap.get(call.createdByUserId)
        const creatorName = (creator?.name ?? "").toLowerCase()
        const creatorMatch = creatorName.includes(query)

        const participantIds = participantsByCall.get(call.id) || []
        const participantMatch = participantIds.some((userId) => {
          const participant = userIdMap.get(userId)
          const name = (participant?.name ?? "").toLowerCase()
          return name.includes(query)
        })

        const invitedIds = invitedUsersByCall.get(call.id) || []
        const invitedMatch = invitedIds.some((userId) => {
          const invited = userIdMap.get(userId)
          const name = (invited?.name ?? "").toLowerCase()
          return name.includes(query)
        })

        return creatorMatch || participantMatch || invitedMatch
      })
    }

    // Enrich call history with user details
    const enrichedHistory = filteredCalls.map((call) => {
      const creator = userIdMap.get(call.createdByUserId)

      const participantIds = participantsByCall.get(call.id) || []
      const participantDetails = participantIds
        .map((userId) => {
          const participant = userIdMap.get(userId)
          return participant
            ? {
                id: participant.externalId,
                name: participant.name,
                email: participant.email,
                photoLink: participant.photoLink,
              }
            : null
        })
        .filter(Boolean)

      const invitedIds = invitedUsersByCall.get(call.id) || []
      const invitedDetails = invitedIds
        .map((userId) => {
          const invited = userIdMap.get(userId)
          return invited
            ? {
                id: invited.externalId,
                name: invited.name,
                email: invited.email,
                photoLink: invited.photoLink,
              }
            : null
        })
        .filter(Boolean)

      return {
        id: call.externalId,
        callId: call.externalId,
        roomLink: call.roomLink,
        callType: call.callType,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        duration: call.endedAt
          ? Math.floor(
              (new Date(call.endedAt).getTime() -
                new Date(call.startedAt).getTime()) /
                1000,
            )
          : null,
        createdBy: creator
          ? {
              id: creator.externalId,
              name: creator.name,
              email: creator.email,
              photoLink: creator.photoLink,
            }
          : null,
        participants: participantDetails,
        invitedUsers: invitedDetails,
      }
    })

    return c.json({
      success: true,
      calls: enrichedHistory,
    })
  } catch (error) {
    Logger.error(error, "Error getting call history")
    throw new HTTPException(500, { message: "Failed to get call history" })
  }
}

// Background cleanup function to mark ended calls
// This should be called periodically (e.g., every minute)
export const cleanupOrphanedCalls = async () => {
  try {
    // Get all active calls (endedAt is null)
    const activeCalls = await db
      .select()
      .from(calls)
      .where(and(isNull(calls.endedAt), isNull(calls.deletedAt)))

    if (activeCalls.length === 0) {
      return
    }

    Logger.info(`Checking ${activeCalls.length} active calls for cleanup`)

    // Check each call in LiveKit (room name is the externalId)
    for (const call of activeCalls) {
      try {
        const rooms = await roomService.listRooms([call.externalId])

        // If room doesn't exist or has no participants, mark as ended
        if (!rooms || rooms.length === 0 || rooms[0].numParticipants === 0) {
          Logger.info(
            `Marking orphaned call ${call.externalId} as ended (room not found or empty)`,
          )

          await db
            .update(calls)
            .set({
              endedAt: new Date(),
            })
            .where(eq(calls.id, call.id))
        }
      } catch (error) {
        Logger.warn(
          `Error checking room ${call.externalId} during cleanup: ${error}`,
        )
        // If we can't find the room, assume it's ended
        await db
          .update(calls)
          .set({
            endedAt: new Date(),
          })
          .where(eq(calls.id, call.id))
      }
    }
  } catch (error) {
    Logger.error(error, "Error during call cleanup")
  }
}

// Start background cleanup (runs every 2 minutes)
const CLEANUP_INTERVAL_MS = 2 * 60 * 1000 // 2 minutes
setInterval(() => {
  cleanupOrphanedCalls().catch((error) => {
    Logger.error(error, "Error in cleanup interval")
  })
}, CLEANUP_INTERVAL_MS)

// Also run cleanup on startup
cleanupOrphanedCalls().catch((error) => {
  Logger.error(error, "Error in initial cleanup")
})
