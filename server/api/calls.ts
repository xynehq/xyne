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
import { calls } from "@/db/schema/calls"
import { eq, desc, and, isNull } from "drizzle-orm"
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
  callType: z.enum(["video", "audio"]).default("video"),
})

export const joinCallSchema = z.object({
  roomName: z.string().min(1, "Room name is required"),
})

export const endCallSchema = z.object({
  roomName: z.string().min(1, "Room name is required"),
})

export const leaveCallSchema = z.object({
  roomName: z.string().min(1, "Room name is required"),
})

export const inviteToCallSchema = z.object({
  roomName: z.string().min(1, "Room name is required"),
  targetUserId: z.string().min(1, "Target user ID is required"),
  callType: z.enum(["video", "audio"]).default("video"),
})

// Generate LiveKit access token
const generateAccessToken = async (
  userIdentity: string,
  roomName: string,
  userName?: string,
): Promise<string> => {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: userIdentity,
    name: userName, // Add user's display name to token
    ttl: "10m", // Token valid for 10 minutes
  })

  at.addGrant({
    roomJoin: true,
    room: roomName,
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

    // Generate unique room name
    const roomName = `call_${caller.externalId}_${targetUser.externalId}_${Date.now()}`
    const callExternalId = randomUUID()
    // Store shareable link with call type (no token - tokens are generated per user when they join)
    const roomLink = `${LIVEKIT_CLIENT_URL || "http://localhost:5173"}/call?room=${roomName}&type=${validatedData.callType}`

    // Create room in LiveKit
    await roomService.createRoom({
      name: roomName,
      maxParticipants: 30, // Allow more participants for group calls
      emptyTimeout: 300, // Room closes after 5 minutes if empty
    })

    // Save call record to database
    // Note: Don't add caller to participants yet - they need to actually join first
    await db.insert(calls).values({
      externalId: callExternalId,
      roomName,
      createdByUserId: caller.id,
      roomLink,
      callType: validatedData.callType,
      participants: [], // Empty initially - users added when they actually join
      invitedUsers: [targetUser.externalId], // Target user is invited
    })

    // Generate access tokens for both users
    const callerToken = await generateAccessToken(
      caller.externalId,
      roomName,
      caller.name,
    )
    const targetToken = await generateAccessToken(
      targetUser.externalId,
      roomName,
      targetUser.name,
    )

    // Send real-time notification to target user
    const callNotification = {
      type: "incoming_call" as const,
      callId: roomName,
      roomName,
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
      roomName,
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
    const { roomName } = requestBody

    // Validate input
    const validatedData = joinCallSchema.parse({ roomName })

    // Get user info
    const users = await getUserByEmail(db, userEmail)
    if (!users || users.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const user = users[0]

    // Check if room exists
    const rooms = await roomService.listRooms([validatedData.roomName])
    if (!rooms || rooms.length === 0) {
      throw new HTTPException(404, { message: "Call room not found" })
    }

    // Update call record - add user to participants if not already there
    const callRecord = await db
      .select()
      .from(calls)
      .where(eq(calls.roomName, validatedData.roomName))
      .limit(1)

    if (callRecord.length > 0) {
      const currentParticipants = callRecord[0].participants || []
      if (!currentParticipants.includes(user.externalId)) {
        await db
          .update(calls)
          .set({
            participants: [...currentParticipants, user.externalId],
          })
          .where(eq(calls.roomName, validatedData.roomName))
      }
    }

    // Generate access token
    const token = await generateAccessToken(
      user.externalId,
      validatedData.roomName,
      user.name,
    )

    return c.json({
      success: true,
      token,
      roomName: validatedData.roomName,
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
    const { roomName, targetUserId, callType } = requestBody

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = inviteToCallSchema.parse({
      roomName,
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

    // Check if room exists
    try {
      const room = await roomService.listRooms([validatedData.roomName])
      if (!room || room.length === 0) {
        throw new HTTPException(404, { message: "Call room not found" })
      }
    } catch (error) {
      throw new HTTPException(404, { message: "Call room not found" })
    }

    // Update call record - add user to invitedUsers if not already there
    const callRecord = await db
      .select()
      .from(calls)
      .where(eq(calls.roomName, validatedData.roomName))
      .limit(1)

    if (callRecord.length > 0) {
      const currentInvitedUsers = callRecord[0].invitedUsers || []
      if (!currentInvitedUsers.includes(targetUser.externalId)) {
        await db
          .update(calls)
          .set({
            invitedUsers: [...currentInvitedUsers, targetUser.externalId],
          })
          .where(eq(calls.roomName, validatedData.roomName))
      }
    }

    // Generate access token for the invited user
    const targetToken = await generateAccessToken(
      targetUser.externalId,
      validatedData.roomName,
      targetUser.name,
    )

    // Send real-time notification to target user
    const callNotification = {
      type: "incoming_call" as const,
      callId: validatedData.roomName,
      roomName: validatedData.roomName,
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
      `User ${inviter.name} invited ${targetUser.name} to call ${validatedData.roomName}`,
    )
    Logger.info(`Real-time notification sent: ${notificationSent}`)

    return c.json({
      success: true,
      roomName: validatedData.roomName,
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
    const { roomName } = requestBody

    // Validate input
    const validatedData = endCallSchema.parse({ roomName })

    // Get user info
    const users = await getUserByEmail(db, userEmail)
    if (!users || users.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }

    // Update call record - set endedAt timestamp
    await db
      .update(calls)
      .set({
        endedAt: new Date(),
      })
      .where(eq(calls.roomName, validatedData.roomName))

    // Delete the room
    await roomService.deleteRoom(validatedData.roomName)

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
    const { roomName } = requestBody

    // Validate input
    const validatedData = leaveCallSchema.parse({ roomName })

    // Get user info
    const users = await getUserByEmail(db, userEmail)
    if (!users || users.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const user = users[0]

    Logger.info(
      `User ${user.email} (${user.externalId}) leaving call ${validatedData.roomName}`,
    )

    // Check if room still exists
    let roomExists = true
    let participantCount = 0
    try {
      const rooms = await roomService.listRooms([validatedData.roomName])
      if (rooms && rooms.length > 0) {
        participantCount = rooms[0].numParticipants
      } else {
        roomExists = false
      }
    } catch (error) {
      Logger.warn(`Room ${validatedData.roomName} not found in LiveKit`)
      roomExists = false
    }

    // If room doesn't exist or has no participants, mark call as ended
    if (!roomExists || participantCount === 0) {
      Logger.info(
        `Room ${validatedData.roomName} is empty or doesn't exist. Marking call as ended.`,
      )

      // Update call record - set endedAt timestamp only if not already set
      await db
        .update(calls)
        .set({
          endedAt: new Date(),
        })
        .where(
          and(
            eq(calls.roomName, validatedData.roomName),
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
        roomName: room.name,
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

    // Get user info
    const users = await getUserByEmail(db, userEmail)
    if (!users || users.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const user = users[0]

    // Get all calls where user is creator, participant, or invited
    // Note: We need to get all calls and filter in-memory because we need to check JSON arrays
    const allCalls = await db
      .select()
      .from(calls)
      .where(isNull(calls.deletedAt))
      .orderBy(desc(calls.startedAt))

    // Filter calls where user participated (as creator, participant, or invited)
    const callHistory = allCalls.filter((call) => {
      const isCreator = call.createdByUserId === user.id
      const isParticipant = call.participants.includes(user.externalId)
      const wasInvited = call.invitedUsers.includes(user.externalId)
      return isCreator || isParticipant || wasInvited
    })

    // Get workspace users to enrich the response with user details
    const workspaceUsers = await getUsersByWorkspace(db, workspaceId)
    const userMap = new Map(workspaceUsers.map((u) => [u.externalId, u]))

    // Enrich call history with user details
    const enrichedHistory = callHistory.map((call) => {
      const creator = userMap.get(
        workspaceUsers.find((u) => u.id === call.createdByUserId)?.externalId ||
          "",
      )

      const participantDetails = call.participants
        .map((pId) => {
          const participant = userMap.get(pId)
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

      const invitedDetails = call.invitedUsers
        .map((iId) => {
          const invited = userMap.get(iId)
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
        roomName: call.roomName,
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

    // Check each call in LiveKit
    for (const call of activeCalls) {
      try {
        const rooms = await roomService.listRooms([call.roomName])

        // If room doesn't exist or has no participants, mark as ended
        if (!rooms || rooms.length === 0 || rooms[0].numParticipants === 0) {
          Logger.info(
            `Marking orphaned call ${call.roomName} as ended (room not found or empty)`,
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
          `Error checking room ${call.roomName} during cleanup: ${error}`,
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
