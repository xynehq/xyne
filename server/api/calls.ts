import { z } from "zod"
import config from "@/config"
import { HTTPException } from "hono/http-exception"
import type { Context } from "hono"
import { AccessToken, RoomServiceClient } from "livekit-server-sdk"
import { db } from "@/db/client"
import { getUserByEmail, getAllActiveUsers } from "@/db/user"
import { callNotificationService } from "@/services/callNotifications"

const { JwtPayloadKey } = config

// LiveKit configuration
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY!
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET!
const LIVEKIT_URL = process.env.LIVEKIT_URL || "ws://localhost:7880"

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  throw new Error("LiveKit API key and secret must be provided in environment variables")
}

const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)

// Schemas
export const initiateCallSchema = z.object({
  targetUserId: z.string().min(1, "Target user ID is required"),
  callType: z.enum(["video", "audio"]).default("video")
})

export const joinCallSchema = z.object({
  roomName: z.string().min(1, "Room name is required")
})

export const endCallSchema = z.object({
  roomName: z.string().min(1, "Room name is required")
})

// Generate LiveKit access token
const generateAccessToken = async (userIdentity: string, roomName: string): Promise<string> => {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: userIdentity,
    ttl: '10m', // Token valid for 10 minutes
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

    // Get all workspace users to find target user
    const allUsers = await getAllActiveUsers(db)
    const targetUser = allUsers.find(user => user.externalId === validatedData.targetUserId)
    
    if (!targetUser) {
      throw new HTTPException(404, { message: "Target user not found" })
    }

    if (caller.externalId === targetUser.externalId) {
      throw new HTTPException(400, { message: "Cannot call yourself" })
    }

    // Generate unique room name
    const roomName = `call_${caller.externalId}_${targetUser.externalId}_${Date.now()}`
    
    // Create room in LiveKit
    await roomService.createRoom({
      name: roomName,
      maxParticipants: 2,
      emptyTimeout: 300, // Room closes after 5 minutes if empty
    })

    // Generate access tokens for both users
    const callerToken = await generateAccessToken(caller.externalId, roomName)
    const targetToken = await generateAccessToken(targetUser.externalId, roomName)

    // Send real-time notification to target user
    const callNotification = {
      type: "incoming_call" as const,
      callId: roomName,
      roomName,
      caller: {
        id: caller.externalId,
        name: caller.name,
        email: caller.email,
        photoLink: caller.photoLink
      },
      target: {
        id: targetUser.externalId,
        name: targetUser.name,
        email: targetUser.email,
        photoLink: targetUser.photoLink
      },
      callType: validatedData.callType,
      targetToken,
      timestamp: Date.now()
    }

    // Send notification via WebSocket
    const notificationSent = callNotificationService.sendCallInvitation(callNotification)
    
    console.log(`Call initiated by ${caller.name} to ${targetUser.name}`)
    console.log(`Real-time notification sent: ${notificationSent}`)

    return c.json({
      success: true,
      roomName,
      callerToken,
      targetToken,
      callType: validatedData.callType,
      notificationSent, // Include whether notification was sent
      caller: {
        id: caller.externalId,
        name: caller.name,
        email: caller.email,
        photoLink: caller.photoLink
      },
      target: {
        id: targetUser.externalId,
        name: targetUser.name,
        email: targetUser.email,
        photoLink: targetUser.photoLink
      }
    })
  } catch (error) {
    console.error("Error initiating call:", error)
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

    // Generate access token
    const token = await generateAccessToken(user.externalId, validatedData.roomName)

    return c.json({
      success: true,
      token,
      roomName: validatedData.roomName,
      livekitUrl: LIVEKIT_URL,
      user: {
        id: user.externalId,
        name: user.name,
        email: user.email,
        photoLink: user.photoLink
      }
    })
  } catch (error) {
    console.error("Error joining call:", error)
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to join call" })
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
    
    // Delete the room
    await roomService.deleteRoom(validatedData.roomName)

    return c.json({
      success: true,
      message: "Call ended successfully"
    })
  } catch (error) {
    console.error("Error ending call:", error)
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to end call" })
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
    const userRooms = rooms.filter(room => 
      room.name.includes(user.externalId) && room.numParticipants > 0
    )

    return c.json({
      success: true,
      activeCalls: userRooms.map(room => ({
        roomName: room.name,
        participants: room.numParticipants,
        createdAt: room.creationTime
      }))
    })
  } catch (error) {
    console.error("Error getting active calls:", error)
    throw new HTTPException(500, { message: "Failed to get active calls" })
  }
}
