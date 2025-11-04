import type { Context } from "hono"
import { db } from "@/db/client"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { randomUUID } from "node:crypto"
import config from "@/config"
import {
  channels,
  channelMembers,
  channelMessages,
  insertChannelSchema,
  insertChannelMemberSchema,
  insertChannelMessageSchema,
  lexicalEditorStateSchema,
} from "@/db/schema"
import { users } from "@/db/schema/users"
import { threads, threadReplies } from "@/db/schema/threads"
import { eq, and, or, desc, sql, asc, inArray, not } from "drizzle-orm"
import { getUserByEmail } from "@/db/user"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { realtimeMessagingService } from "@/services/callNotifications"
import { ChannelType, ChannelMemberRole } from "@/shared/types"

const { JwtPayloadKey } = config
const Logger = getLogger(Subsystem.Api).child({ module: "channels" })

// Helper functions for cursor-based pagination
const encodeCursor = (id: number): string => {
  return Buffer.from(id.toString()).toString("base64")
}

const decodeCursor = (cursor: string): number | null => {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8")
    const id = parseInt(decoded, 10)
    return isNaN(id) ? null : id
  } catch {
    return null
  }
}

// ==================== Validation Schemas ====================

export const createChannelSchema = z.object({
  name: z
    .string()
    .min(1, "Channel name is required")
    .max(80, "Channel name must be less than 80 characters")
    .regex(
      /^[a-z0-9-_]+$/,
      "Channel name can only contain lowercase letters, numbers, hyphens, and underscores",
    ),
  description: z.string().max(250).optional(),
  purpose: z.string().max(250).optional(),
  type: z.nativeEnum(ChannelType),
  memberIds: z.array(z.string()).optional(), // User external IDs to add as members
})

export const updateChannelSchema = z.object({
  channelId: z.coerce.number().int().positive(),
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-_]+$/)
    .optional(),
  description: z.string().max(250).optional(),
  purpose: z.string().max(250).optional(),
})

export const archiveChannelSchema = z.object({
  channelId: z.coerce.number().int().positive(),
})

export const addMembersSchema = z.object({
  channelId: z.coerce.number().int().positive(),
  memberIds: z.array(z.string()).min(1, "At least one member is required"),
})

export const removeMemberSchema = z.object({
  channelId: z.coerce.number().int().positive(),
  memberId: z.string(),
})

export const updateMemberRoleSchema = z.object({
  channelId: z.coerce.number().int().positive(),
  memberId: z.string(),
  role: z.nativeEnum(ChannelMemberRole),
})

export const leaveChannelSchema = z.object({
  channelId: z.coerce.number().int().positive(),
})

export const sendChannelMessageSchema = z.object({
  channelId: z.coerce.number().int().positive(),
  messageContent: lexicalEditorStateSchema,
  parentMessageId: z.number().int().positive().optional(),
})

export const getChannelMessagesSchema = z.object({
  channelId: z.coerce.number().int().positive(),
  limit: z.coerce.number().min(1).max(200).optional().default(50),
  cursor: z.string().optional(),
})

export const editChannelMessageSchema = z.object({
  messageId: z.coerce.number().int().positive(),
  messageContent: lexicalEditorStateSchema,
})

export const deleteChannelMessageSchema = z.object({
  messageId: z.coerce.number().int().positive(),
})

export const pinMessageSchema = z.object({
  messageId: z.coerce.number().int().positive(),
})

export const unpinMessageSchema = z.object({
  messageId: z.coerce.number().int().positive(),
})

export const joinChannelSchema = z.object({
  channelId: z.coerce.number().int().positive(),
})

export const getPinnedMessagesSchema = z.object({
  channelId: z.coerce.number().int().positive(),
})

export const getChannelMembersSchema = z.object({
  channelId: z.coerce.number().int().positive(),
})

export const getUserChannelsSchema = z.object({
  includeArchived: z.coerce.boolean().optional().default(false),
})

export const channelIdParamSchema = z.object({
  channelId: z.coerce.number().int().positive(),
})

// ==================== Helper Functions ====================

// Get channel by external ID
const getChannelByExternalId = async (channelExternalId: string) => {
  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.channelExternalId, channelExternalId))
    .limit(1)

  return channel
}

// Check if user is a member of a channel (using internal ID)
const isChannelMember = async (
  channelId: number,
  userId: number,
): Promise<boolean> => {
  const [membership] = await db
    .select()
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.userId, userId),
      ),
    )
    .limit(1)

  return !!membership
}

// Check if user is a member of a channel (using external ID)
const isChannelMemberByExternalId = async (
  channelExternalId: string,
  userId: number,
): Promise<boolean> => {
  const channel = await getChannelByExternalId(channelExternalId)
  if (!channel) return false

  return isChannelMember(channel.id, userId)
}

// Get user's role in a channel
const getUserChannelRole = async (
  channelId: number,
  userId: number,
): Promise<ChannelMemberRole | null> => {
  const [membership] = await db
    .select({ role: channelMembers.role })
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.userId, userId),
      ),
    )
    .limit(1)

  return membership ? (membership.role as ChannelMemberRole) : null
}

// Check if user has admin privileges (owner or admin)
const hasAdminPrivileges = (role: ChannelMemberRole | null): boolean => {
  return role === ChannelMemberRole.Owner || role === ChannelMemberRole.Admin
}

// Extract plain text from Lexical JSON for notifications
const extractPlainText = (lexicalJson: any, maxDepth = 100): string => {
  const traverse = (node: any, depth = 0): string => {
    if (!node) return ""
    if (depth > maxDepth) return ""
    if (node.text) return node.text
    if (node.children && Array.isArray(node.children)) {
      return node.children
        .map((child: any) => traverse(child, depth + 1))
        .join("")
    }
    return ""
  }
  return traverse(lexicalJson.root)
}

// Ensures the channel exists and belongs to the workspace
const assertChannelBelongsToWorkspace = async (
  channelId: number,
  workspaceId: number,
) => {
  const [channel] = await db
    .select()
    .from(channels)
    .where(
      and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)),
    )
    .limit(1)
  if (!channel) throw new HTTPException(404, { message: "Channel not found" })
  return channel
}

// Ensures the message exists and belongs to the workspace via its channel
const assertMessageBelongsToWorkspace = async (
  messageId: number,
  workspaceId: number,
) => {
  const [row] = await db
    .select({
      message: channelMessages,
      channelWorkspaceId: channels.workspaceId,
    })
    .from(channelMessages)
    .innerJoin(channels, eq(channels.id, channelMessages.channelId))
    .where(eq(channelMessages.id, messageId))
    .limit(1)
  if (!row) throw new HTTPException(404, { message: "Message not found" })
  if (row.channelWorkspaceId !== workspaceId) {
    throw new HTTPException(403, {
      message: "You do not have access to this message",
    })
  }
  return row.message
}

// ==================== Channel CRUD APIs ====================

// Create a new channel
export const CreateChannelApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = createChannelSchema.parse(requestBody)

    // Get creator info
    const creatorUsers = await getUserByEmail(db, userEmail)
    if (!creatorUsers || creatorUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const creator = creatorUsers[0]

    // Check if channel name already exists in workspace
    const [existingChannel] = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.workspaceId, creator.workspaceId),
          eq(channels.name, validatedData.name.toLowerCase()),
        ),
      )
      .limit(1)

    if (existingChannel) {
      throw new HTTPException(409, {
        message: "A channel with this name already exists",
      })
    }

    // Create channel
    const channelExternalId = randomUUID()
    const [channel] = await db
      .insert(channels)
      .values({
        channelExternalId,
        workspaceId: creator.workspaceId,
        name: validatedData.name.toLowerCase(),
        description: validatedData.description,
        purpose: validatedData.purpose,
        type: validatedData.type,
        createdByUserId: creator.id,
      })
      .returning()

    // Add creator as owner
    await db.insert(channelMembers).values({
      channelId: channel.id,
      userId: creator.id,
      role: ChannelMemberRole.Owner,
    })

    // Add additional members if specified
    if (validatedData.memberIds && validatedData.memberIds.length > 0) {
      // Get user IDs from external IDs
      const membersToAdd = await db
        .select()
        .from(users)
        .where(
          and(
            inArray(users.externalId, validatedData.memberIds),
            eq(users.workspaceId, creator.workspaceId),
          ),
        )

      // Filter out the creator to avoid duplicate key error
      const uniqueMembers = membersToAdd.filter(
        (user) => user.id !== creator.id,
      )

      if (uniqueMembers.length > 0) {
        await db.insert(channelMembers).values(
          uniqueMembers.map((user) => ({
            channelId: channel.id,
            userId: user.id,
            role: ChannelMemberRole.Member,
          })),
        )
      }
    }

    Logger.info({
      msg: "Channel created",
      channelId: channel.id,
      channelName: channel.name,
      creatorId: creator.externalId,
    })

    return c.json({
      success: true,
      channel: {
        id: channel.id,
        name: channel.name,
        description: channel.description,
        purpose: channel.purpose,
        type: channel.type,
        isArchived: channel.isArchived,
        createdAt: channel.createdAt,
      },
    })
  } catch (error) {
    Logger.error(error, "Error creating channel")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to create channel" })
  }
}

// Get channel details
export const GetChannelDetailsApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate path parameters
    const validatedParams = channelIdParamSchema.parse({
      channelId: c.req.param("channelId"),
    })
    const channelId = validatedParams.channelId

    Logger.info({
      msg: "GetChannelDetailsApi called",
      channelId,
      allParams: c.req.param(),
    })

    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get channel
    const channelResult = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.workspaceId, currentUser.workspaceId),
        ),
      )
      .limit(1)

    if (!channelResult || channelResult.length === 0) {
      throw new HTTPException(404, { message: "Channel not found" })
    }

    const channel = channelResult[0]

    // Check if user is a member
    const membershipResult = await db
      .select()
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, channel.id),
          eq(channelMembers.userId, currentUser.id),
        ),
      )
      .limit(1)

    if (!membershipResult || membershipResult.length === 0) {
      throw new HTTPException(403, {
        message: "You are not a member of this channel",
      })
    }

    const membership = membershipResult[0]

    // Get member count
    const memberCountResult = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(channelMembers)
      .where(eq(channelMembers.channelId, channel.id))

    const memberCount = memberCountResult[0]?.count || 0

    return c.json({
      id: channel.id,
      name: channel.name,
      description: channel.description,
      purpose: channel.purpose,
      type: channel.type,
      isArchived: channel.isArchived,
      createdAt: channel.createdAt,
      archivedAt: channel.archivedAt,
      memberRole: membership.role,
      joinedAt: membership.joinedAt,
      lastReadAt: membership.lastReadAt,
      memberCount,
    })
  } catch (error) {
    Logger.error(error, "Error getting channel details")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to get channel details" })
  }
}

// Update channel details
export const UpdateChannelApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = updateChannelSchema.parse(requestBody)
    const channelId = validatedData.channelId

    // Get current user
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get channel and verify it belongs to workspace
    const channel = await assertChannelBelongsToWorkspace(
      channelId,
      currentUser.workspaceId,
    )

    if (channel.isArchived) {
      throw new HTTPException(400, {
        message: "Cannot update archived channel",
      })
    }

    // Check if user has admin privileges
    const userRole = await getUserChannelRole(channel.id, currentUser.id)
    if (!hasAdminPrivileges(userRole)) {
      throw new HTTPException(403, {
        message: "Only channel admins and owners can update channel details",
      })
    }

    // Check if new name conflicts with existing channel
    if (validatedData.name && validatedData.name !== channel.name) {
      const [existingChannel] = await db
        .select()
        .from(channels)
        .where(
          and(
            eq(channels.workspaceId, channel.workspaceId),
            eq(channels.name, validatedData.name.toLowerCase()),
            not(eq(channels.id, channel.id)),
          ),
        )
        .limit(1)

      if (existingChannel) {
        throw new HTTPException(409, {
          message: "A channel with this name already exists",
        })
      }
    }

    // Update channel
    const updateData: any = { updatedAt: new Date() }
    if (validatedData.name) updateData.name = validatedData.name.toLowerCase()
    if (validatedData.description !== undefined)
      updateData.description = validatedData.description
    if (validatedData.purpose !== undefined)
      updateData.purpose = validatedData.purpose

    const [updatedChannel] = await db
      .update(channels)
      .set(updateData)
      .where(eq(channels.id, channelId))
      .returning()

    Logger.info({
      msg: "Channel updated",
      channelId: updatedChannel.id,
      userId: currentUser.externalId,
    })

    return c.json({
      success: true,
      channel: {
        id: updatedChannel.id,
        name: updatedChannel.name,
        description: updatedChannel.description,
        purpose: updatedChannel.purpose,
        type: updatedChannel.type,
        updatedAt: updatedChannel.updatedAt,
      },
    })
  } catch (error) {
    Logger.error(error, "Error updating channel")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to update channel" })
  }
}

// Delete a channel (owner only)
export const DeleteChannelApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate path parameters
    const validatedParams = channelIdParamSchema.parse({
      channelId: c.req.param("channelId"),
    })
    const channelId = validatedParams.channelId

    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get channel
    const channelResult = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.workspaceId, currentUser.workspaceId),
        ),
      )
      .limit(1)

    if (!channelResult || channelResult.length === 0) {
      throw new HTTPException(404, { message: "Channel not found" })
    }

    const channel = channelResult[0]

    // Check if user is owner
    const membershipResult = await db
      .select()
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, channel.id),
          eq(channelMembers.userId, currentUser.id),
        ),
      )
      .limit(1)

    if (!membershipResult || membershipResult.length === 0) {
      throw new HTTPException(403, {
        message: "You are not a member of this channel",
      })
    }

    const membership = membershipResult[0]

    if (membership.role !== ChannelMemberRole.Owner) {
      throw new HTTPException(403, {
        message: "Only the channel owner can delete the channel",
      })
    }

    // Delete all channel messages
    await db
      .delete(channelMessages)
      .where(eq(channelMessages.channelId, channel.id))

    // Delete all channel members
    await db
      .delete(channelMembers)
      .where(eq(channelMembers.channelId, channel.id))

    // Delete the channel
    await db.delete(channels).where(eq(channels.id, channel.id))

    Logger.info(
      { channelId: channel.id, channelName: channel.name },
      "Channel deleted successfully",
    )

    return c.json({ message: "Channel deleted successfully" })
  } catch (error) {
    Logger.error(error, "Error deleting channel")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to delete channel" })
  }
}

// Archive/Unarchive a channel
export const ArchiveChannelApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = archiveChannelSchema.parse(requestBody)
    const channelId = validatedData.channelId

    // Get current user
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get channel and verify it belongs to workspace
    const channel = await assertChannelBelongsToWorkspace(
      channelId,
      currentUser.workspaceId,
    )

    // Check if user has admin privileges
    const userRole = await getUserChannelRole(channel.id, currentUser.id)
    if (!hasAdminPrivileges(userRole)) {
      throw new HTTPException(403, {
        message: "Only channel admins and owners can archive channels",
      })
    }

    // Toggle archive status
    const [updatedChannel] = await db
      .update(channels)
      .set({
        isArchived: !channel.isArchived,
        archivedAt: channel.isArchived ? null : new Date(),
        updatedAt: new Date(),
      })
      .where(eq(channels.id, channelId))
      .returning()

    Logger.info({
      msg: channel.isArchived ? "Channel unarchived" : "Channel archived",
      channelId: updatedChannel.id,
      userId: currentUser.externalId,
    })

    return c.json({
      success: true,
      channel: {
        id: updatedChannel.id,
        isArchived: updatedChannel.isArchived,
        archivedAt: updatedChannel.archivedAt,
      },
    })
  } catch (error) {
    Logger.error(error, "Error archiving/unarchiving channel")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, {
      message: "Failed to archive/unarchive channel",
    })
  }
}

// Get all channels for current user
export const GetUserChannelsApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Get current user
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Validate query parameters
    const validatedQuery = getUserChannelsSchema.parse({
      includeArchived: c.req.query("includeArchived"),
    })
    const includeArchived = validatedQuery.includeArchived

    // Get all channels the user is a member of
    const userChannels = await db
      .select({
        channelId: channels.id,
        channelName: channels.name,
        channelDescription: channels.description,
        channelPurpose: channels.purpose,
        channelType: channels.type,
        channelIsArchived: channels.isArchived,
        channelCreatedAt: channels.createdAt,
        channelArchivedAt: channels.archivedAt,
        memberRole: channelMembers.role,
        memberJoinedAt: channelMembers.joinedAt,
        lastReadAt: channelMembers.lastReadAt,
      })
      .from(channelMembers)
      .innerJoin(channels, eq(channels.id, channelMembers.channelId))
      .where(
        and(
          eq(channelMembers.userId, currentUser.id),
          eq(channels.workspaceId, currentUser.workspaceId),
          includeArchived ? sql`1=1` : eq(channels.isArchived, false),
        ),
      )
      .orderBy(desc(channels.createdAt))

    return c.json({
      success: true,
      channels: userChannels.map((ch) => ({
        id: ch.channelId,
        name: ch.channelName,
        description: ch.channelDescription,
        purpose: ch.channelPurpose,
        type: ch.channelType,
        isArchived: ch.channelIsArchived,
        createdAt: ch.channelCreatedAt,
        archivedAt: ch.channelArchivedAt,
        memberRole: ch.memberRole,
        joinedAt: ch.memberJoinedAt,
        lastReadAt: ch.lastReadAt,
      })),
    })
  } catch (error) {
    Logger.error(error, "Error getting user channels")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to get user channels" })
  }
}

// Browse public channels (for discovery)
export const BrowsePublicChannelsApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Get current user
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get all public channels in workspace that user is NOT a member of
    const publicChannels = await db
      .select({
        channelId: channels.id,
        channelName: channels.name,
        channelDescription: channels.description,
        channelPurpose: channels.purpose,
        channelCreatedAt: channels.createdAt,
        memberCount: sql<number>`COUNT(${channelMembers.id})::int`,
      })
      .from(channels)
      .leftJoin(channelMembers, eq(channelMembers.channelId, channels.id))
      .where(
        and(
          eq(channels.workspaceId, currentUser.workspaceId),
          eq(channels.type, ChannelType.Public),
          eq(channels.isArchived, false),
          // Exclude channels user is already a member of
          sql`${channels.id} NOT IN (
            SELECT channel_id FROM channel_members WHERE user_id = ${currentUser.id}
          )`,
        ),
      )
      .groupBy(
        channels.id,
        channels.name,
        channels.description,
        channels.purpose,
        channels.createdAt,
      )
      .orderBy(desc(channels.createdAt))

    return c.json({
      success: true,
      channels: publicChannels.map((ch) => ({
        id: ch.channelId,
        name: ch.channelName,
        description: ch.channelDescription,
        purpose: ch.channelPurpose,
        createdAt: ch.channelCreatedAt,
        memberCount: ch.memberCount,
      })),
    })
  } catch (error) {
    Logger.error(error, "Error browsing public channels")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, {
      message: "Failed to browse public channels",
    })
  }
}

// Join a public channel
export const JoinChannelApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = joinChannelSchema.parse(requestBody)
    const channelId = validatedData.channelId

    // Get current user
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get channel
    const [channel] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1)

    if (!channel) {
      throw new HTTPException(404, { message: "Channel not found" })
    }

    // SECURITY: Verify channel belongs to user's workspace
    if (channel.workspaceId !== currentUser.workspaceId) {
      throw new HTTPException(403, {
        message: "You do not have access to this channel",
      })
    }

    if (channel.isArchived) {
      throw new HTTPException(400, { message: "Cannot join archived channel" })
    }

    if (channel.type === ChannelType.Private) {
      throw new HTTPException(403, {
        message: "Cannot join private channel without an invitation",
      })
    }

    // Check if already a member
    const isMember = await isChannelMember(channelId, currentUser.id)
    if (isMember) {
      throw new HTTPException(400, {
        message: "Already a member of this channel",
      })
    }

    // Add user as member
    await db.insert(channelMembers).values({
      channelId: channelId,
      userId: currentUser.id,
      role: ChannelMemberRole.Member,
    })

    Logger.info({
      msg: "User joined channel",
      channelId: channelId,
      userId: currentUser.externalId,
    })

    return c.json({
      success: true,
      message: "Successfully joined channel",
    })
  } catch (error) {
    Logger.error(error, "Error joining channel")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to join channel" })
  }
}

// ==================== Member Management APIs ====================

// Add members to channel
export const AddChannelMembersApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = addMembersSchema.parse(requestBody)
    const channelId = validatedData.channelId

    // Get current user
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get channel and verify it belongs to workspace
    const channel = await assertChannelBelongsToWorkspace(
      channelId,
      currentUser.workspaceId,
    )

    if (channel.isArchived) {
      throw new HTTPException(400, {
        message: "Cannot add members to archived channel",
      })
    }

    // Check if user has admin privileges (for private channels)
    if (channel.type === ChannelType.Private) {
      const userRole = await getUserChannelRole(channel.id, currentUser.id)
      if (!hasAdminPrivileges(userRole)) {
        throw new HTTPException(403, {
          message: "Only channel admins can add members to private channels",
        })
      }
    } else {
      // For public channels, any member can add other members
      const isMember = await isChannelMember(channel.id, currentUser.id)
      if (!isMember) {
        throw new HTTPException(403, {
          message: "Must be a channel member to add others",
        })
      }
    }

    // Get users to add
    const usersToAdd = await db
      .select()
      .from(users)
      .where(
        and(
          inArray(users.externalId, validatedData.memberIds),
          eq(users.workspaceId, currentUser.workspaceId),
        ),
      )

    if (usersToAdd.length === 0) {
      throw new HTTPException(404, { message: "No valid users found to add" })
    }

    // Get existing members
    const existingMembers = await db
      .select({ userId: channelMembers.userId })
      .from(channelMembers)
      .where(eq(channelMembers.channelId, channel.id))

    const existingMemberIds = new Set(existingMembers.map((m) => m.userId))

    // Filter out users who are already members
    const newMembers = usersToAdd.filter(
      (user) => !existingMemberIds.has(user.id),
    )

    if (newMembers.length === 0) {
      throw new HTTPException(400, {
        message: "All specified users are already members",
      })
    }

    // Add new members
    await db.insert(channelMembers).values(
      newMembers.map((user) => ({
        channelId: channel.id,
        userId: user.id,
        role: ChannelMemberRole.Member,
      })),
    )

    Logger.info({
      msg: "Members added to channel",
      channelId: channel.id,
      addedCount: newMembers.length,
      addedBy: currentUser.externalId,
    })

    return c.json({
      success: true,
      message: `Successfully added ${newMembers.length} member(s)`,
      addedMembers: newMembers.map((user) => ({
        id: user.externalId,
        name: user.name,
        email: user.email,
      })),
    })
  } catch (error) {
    Logger.error(error, "Error adding channel members")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to add channel members" })
  }
}

// Remove a member from channel
export const RemoveChannelMemberApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = removeMemberSchema.parse(requestBody)
    const channelId = validatedData.channelId

    // Get current user
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get user to remove (ensure they're in same workspace)
    const [userToRemove] = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.externalId, validatedData.memberId),
          eq(users.workspaceId, currentUser.workspaceId),
        ),
      )
      .limit(1)

    if (!userToRemove) {
      throw new HTTPException(404, { message: "User to remove not found" })
    }

    // Get channel and verify it belongs to workspace
    const channel = await assertChannelBelongsToWorkspace(
      channelId,
      currentUser.workspaceId,
    )

    // Check if user has admin privileges
    const currentUserRole = await getUserChannelRole(channel.id, currentUser.id)
    if (!hasAdminPrivileges(currentUserRole)) {
      throw new HTTPException(403, {
        message: "Only channel admins can remove members",
      })
    }

    // Cannot remove the owner
    const memberToRemoveRole = await getUserChannelRole(
      channel.id,
      userToRemove.id,
    )
    if (memberToRemoveRole === ChannelMemberRole.Owner) {
      throw new HTTPException(400, { message: "Cannot remove channel owner" })
    }

    // Remove member
    await db
      .delete(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, channel.id),
          eq(channelMembers.userId, userToRemove.id),
        ),
      )

    Logger.info({
      msg: "Member removed from channel",
      channelId: channel.id,
      removedUserId: userToRemove.externalId,
      removedBy: currentUser.externalId,
    })

    return c.json({
      success: true,
      message: "Member removed successfully",
    })
  } catch (error) {
    Logger.error(error, "Error removing channel member")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to remove channel member" })
  }
}

// Update member role
export const UpdateMemberRoleApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = updateMemberRoleSchema.parse(requestBody)
    const channelId = validatedData.channelId

    // Get current user
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get user whose role is being updated (ensure they're in same workspace)
    const [targetUser] = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.externalId, validatedData.memberId),
          eq(users.workspaceId, currentUser.workspaceId),
        ),
      )
      .limit(1)

    if (!targetUser) {
      throw new HTTPException(404, { message: "Target user not found" })
    }

    // Get channel and verify it belongs to workspace
    const channel = await assertChannelBelongsToWorkspace(
      channelId,
      currentUser.workspaceId,
    )

    // Only owner can change roles
    const currentUserRole = await getUserChannelRole(channel.id, currentUser.id)
    if (currentUserRole !== ChannelMemberRole.Owner) {
      throw new HTTPException(403, {
        message: "Only channel owner can change member roles",
      })
    }

    // Cannot change owner's role
    const targetUserRole = await getUserChannelRole(channel.id, targetUser.id)
    if (targetUserRole === ChannelMemberRole.Owner) {
      throw new HTTPException(400, { message: "Cannot change owner's role" })
    }

    // Cannot set someone else as owner
    if (validatedData.role === ChannelMemberRole.Owner) {
      throw new HTTPException(400, {
        message: "Cannot assign owner role to another user",
      })
    }

    // Update role
    await db
      .update(channelMembers)
      .set({ role: validatedData.role })
      .where(
        and(
          eq(channelMembers.channelId, channel.id),
          eq(channelMembers.userId, targetUser.id),
        ),
      )

    Logger.info({
      msg: "Member role updated",
      channelId: channel.id,
      targetUserId: targetUser.externalId,
      newRole: validatedData.role,
      updatedBy: currentUser.externalId,
    })

    return c.json({
      success: true,
      message: "Member role updated successfully",
    })
  } catch (error) {
    Logger.error(error, "Error updating member role")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to update member role" })
  }
}

// Leave a channel
export const LeaveChannelApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = leaveChannelSchema.parse(requestBody)
    const channelId = validatedData.channelId

    // Get current user
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get channel and verify it belongs to workspace
    const channel = await assertChannelBelongsToWorkspace(
      channelId,
      currentUser.workspaceId,
    )

    // Ensure user is a member before leaving
    const isMember = await isChannelMember(channel.id, currentUser.id)
    if (!isMember) {
      throw new HTTPException(400, {
        message: "You are not a member of this channel",
      })
    }

    // Check if user is the owner
    const userRole = await getUserChannelRole(channel.id, currentUser.id)
    if (userRole === ChannelMemberRole.Owner) {
      // Check if there are other members
      const memberCount = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(channelMembers)
        .where(eq(channelMembers.channelId, channel.id))

      if (memberCount[0].count > 1) {
        throw new HTTPException(400, {
          message:
            "Channel owner cannot leave. Transfer ownership or remove all members first.",
        })
      }
    }

    // Remove user from channel
    await db
      .delete(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, channel.id),
          eq(channelMembers.userId, currentUser.id),
        ),
      )

    Logger.info({
      msg: "User left channel",
      channelId: channel.id,
      userId: currentUser.externalId,
    })

    return c.json({
      success: true,
      message: "Successfully left channel",
    })
  } catch (error) {
    Logger.error(error, "Error leaving channel")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to leave channel" })
  }
}

// Get channel members
export const GetChannelMembersApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate query parameters
    const validatedQuery = getChannelMembersSchema.parse({
      channelId: c.req.query("channelId"),
    })
    const channelId = validatedQuery.channelId

    // Get current user
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Verify channel belongs to workspace
    await assertChannelBelongsToWorkspace(channelId, currentUser.workspaceId)

    // Check if user is a member of the channel
    const isMember = await isChannelMember(channelId, currentUser.id)
    if (!isMember) {
      throw new HTTPException(403, {
        message: "Must be a channel member to view members",
      })
    }

    // Get all members
    const members = await db
      .select({
        userId: users.externalId,
        userName: users.name,
        userEmail: users.email,
        userPhotoLink: users.photoLink,
        role: channelMembers.role,
        joinedAt: channelMembers.joinedAt,
      })
      .from(channelMembers)
      .innerJoin(users, eq(users.id, channelMembers.userId))
      .where(eq(channelMembers.channelId, channelId))
      .orderBy(channelMembers.joinedAt)

    return c.json({
      success: true,
      members: members.map((m) => ({
        id: m.userId,
        name: m.userName,
        email: m.userEmail,
        photoLink: m.userPhotoLink,
        role: m.role,
        joinedAt: m.joinedAt,
      })),
    })
  } catch (error) {
    Logger.error(error, "Error getting channel members")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to get channel members" })
  }
}

// ==================== Messaging APIs ====================

// Send message to channel
export const SendChannelMessageApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = sendChannelMessageSchema.parse(requestBody)
    const channelId = validatedData.channelId

    // Get sender
    const senderUsers = await getUserByEmail(db, userEmail)
    if (!senderUsers || senderUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const sender = senderUsers[0]

    // Ensure the channel belongs to this workspace before proceeding
    await assertChannelBelongsToWorkspace(channelId, sender.workspaceId)

    // Check if user is a member of the channel
    const isMember = await isChannelMember(channelId, sender.id)
    if (!isMember) {
      throw new HTTPException(403, {
        message: "Must be a channel member to send messages",
      })
    }

    // Insert message
    const [message] = await db
      .insert(channelMessages)
      .values({
        channelId: channelId,
        sentByUserId: sender.id,
        messageContent: validatedData.messageContent,
      })
      .returning()

    Logger.info({
      msg: "Channel message sent",
      messageId: message.id,
      channelId: message.channelId,
      senderId: sender.externalId,
    })

    // Send real-time notification to all channel members
    // Get all channel members
    const members = await db
      .select({ userId: users.externalId, channelName: channels.name })
      .from(channelMembers)
      .innerJoin(users, eq(users.id, channelMembers.userId))
      .innerJoin(channels, eq(channels.id, channelMembers.channelId))
      .where(eq(channelMembers.channelId, channelId))

    if (members.length > 0) {
      const memberIds = members.map((m) => m.userId)
      const plainTextContent = extractPlainText(message.messageContent)

      const channelNotification = {
        type: "channel_message" as const,
        messageId: message.id,
        channelId: message.channelId,
        channelName: members[0].channelName,
        messageContent: message.messageContent,
        plainTextContent,
        createdAt: message.createdAt,
        sender: {
          id: sender.externalId,
          name: sender.name,
          email: sender.email,
          photoLink: sender.photoLink,
        },
        timestamp: Date.now(),
      }

      realtimeMessagingService.sendChannelMessage(
        memberIds,
        channelNotification,
      )
    }

    return c.json({
      success: true,
      message: {
        id: message.id,
        channelId: message.channelId,
        sentByUserId: sender.externalId,
        messageContent: message.messageContent,
        isEdited: message.isEdited,
        isPinned: message.isPinned,
        createdAt: message.createdAt,
        sender: {
          id: sender.externalId,
          name: sender.name,
          email: sender.email,
          photoLink: sender.photoLink,
        },
      },
    })
  } catch (error) {
    Logger.error(error, "Error sending channel message")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to send channel message" })
  }
}

// Get channel messages with pagination
export const GetChannelMessagesApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Get query parameters
    const channelIdStr = c.req.query("channelId")
    const limitStr = c.req.query("limit") ?? undefined
    const cursor = c.req.query("cursor")

    // Parse and validate
    const validatedData = getChannelMessagesSchema.parse({
      channelId: channelIdStr,
      limit: limitStr ?? undefined,
      cursor,
    })

    // Get current user
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Verify the channel belongs to this workspace before checking membership
    await assertChannelBelongsToWorkspace(
      validatedData.channelId,
      currentUser.workspaceId,
    )

    // Check if user is a member of the channel
    const isMember = await isChannelMember(
      validatedData.channelId,
      currentUser.id,
    )
    if (!isMember) {
      throw new HTTPException(403, {
        message: "Must be a channel member to view messages",
      })
    }

    // Decode cursor
    let cursorId: number | null = null
    if (validatedData.cursor) {
      cursorId = decodeCursor(validatedData.cursor)
      if (cursorId === null) {
        throw new HTTPException(400, { message: "Invalid cursor" })
      }
    }

    // Fetch messages
    const fetchLimit = validatedData.limit + 1

    const messages = await db
      .select({
        id: channelMessages.id,
        messageContent: channelMessages.messageContent,
        isEdited: channelMessages.isEdited,
        isPinned: channelMessages.isPinned,
        pinnedAt: channelMessages.pinnedAt,
        createdAt: channelMessages.createdAt,
        senderExternalId: users.externalId,
        senderName: users.name,
        senderEmail: users.email,
        senderPhotoLink: users.photoLink,
        // Thread information
        threadId: threads.id,
        replyCount: threads.replyCount,
        lastReplyAt: threads.lastReplyAt,
      })
      .from(channelMessages)
      .innerJoin(users, eq(users.id, channelMessages.sentByUserId))
      .leftJoin(
        threads,
        and(
          eq(threads.parentMessageId, channelMessages.id),
          eq(threads.messageType, "channel"),
        ),
      )
      .where(
        and(
          eq(channelMessages.channelId, validatedData.channelId),
          sql`${channelMessages.deletedAt} IS NULL`,
          cursorId ? sql`${channelMessages.id} < ${cursorId}` : sql`1=1`,
        ),
      )
      .orderBy(desc(channelMessages.id))
      .limit(fetchLimit)

    // Check if there are more messages
    const hasMore = messages.length > validatedData.limit
    const resultMessages = hasMore ? messages.slice(0, -1) : messages

    // Generate next cursor
    const nextCursor =
      hasMore && resultMessages.length > 0
        ? encodeCursor(resultMessages[resultMessages.length - 1].id)
        : ""

    // Reverse messages for display (oldest to newest)
    const displayMessages = resultMessages.reverse()

    // Fetch repliers for messages with threads (limit to 3 most recent unique repliers per thread)
    const threadIds = displayMessages
      .filter((msg) => msg.threadId)
      .map((msg) => msg.threadId!)

    let repliersMap = new Map<
      number,
      Array<{ userId: number; name: string; photoLink: string | null }>
    >()

    if (threadIds.length > 0) {
      // Get distinct repliers for each thread (limit 3 most recent unique repliers per thread)
      // We need to get all replies, then group by thread and get unique senders
      const allReplies = await db
        .select({
          threadId: threadReplies.threadId,
          senderId: threadReplies.senderId,
          senderName: users.name,
          senderPhotoLink: users.photoLink,
          createdAt: threadReplies.createdAt,
        })
        .from(threadReplies)
        .innerJoin(users, eq(users.id, threadReplies.senderId))
        .where(
          and(
            inArray(threadReplies.threadId, threadIds),
            sql`${threadReplies.deletedAt} IS NULL`,
          ),
        )
        .orderBy(desc(threadReplies.createdAt))

      // Group by thread ID and get up to 3 unique senders per thread
      for (const reply of allReplies) {
        if (!repliersMap.has(reply.threadId)) {
          repliersMap.set(reply.threadId, [])
        }
        const threadRepliers = repliersMap.get(reply.threadId)!

        // Check if this sender is already in the list (by userId, not name)
        const alreadyAdded = threadRepliers.some(
          (r) => r.userId === reply.senderId,
        )

        // Add if not already added and we haven't reached the limit of 3
        if (!alreadyAdded && threadRepliers.length < 3) {
          threadRepliers.push({
            userId: reply.senderId,
            name: reply.senderName,
            photoLink: reply.senderPhotoLink,
          })
        }
      }
    }

    return c.json({
      success: true,
      messages: displayMessages.map((msg) => ({
        id: msg.id,
        messageContent: msg.messageContent,
        isEdited: msg.isEdited,
        isPinned: msg.isPinned,
        pinnedAt: msg.pinnedAt,
        createdAt: msg.createdAt,
        sender: {
          id: msg.senderExternalId,
          name: msg.senderName,
          email: msg.senderEmail,
          photoLink: msg.senderPhotoLink,
        },
        // Thread information
        threadId: msg.threadId,
        replyCount: msg.replyCount || 0,
        lastReplyAt: msg.lastReplyAt,
        repliers: msg.threadId
          ? (repliersMap.get(msg.threadId) || []).map(
              ({ userId, name, photoLink }) => ({
                userId,
                name,
                photoLink,
              }),
            )
          : [],
      })),
      responseMetadata: {
        hasMore,
        nextCursor,
      },
    })
  } catch (error) {
    Logger.error(error, "Error getting channel messages")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to get channel messages" })
  }
}

// Edit channel message
export const EditChannelMessageApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = editChannelMessageSchema.parse(requestBody)
    const messageId = validatedData.messageId

    // Get current user
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get message and verify it belongs to workspace
    const message = await assertMessageBelongsToWorkspace(
      messageId,
      currentUser.workspaceId,
    )

    if (message.sentByUserId !== currentUser.id) {
      throw new HTTPException(403, {
        message: "Can only edit your own messages",
      })
    }

    if (message.deletedAt) {
      throw new HTTPException(400, { message: "Cannot edit deleted message" })
    }

    // Update message
    const [updatedMessage] = await db
      .update(channelMessages)
      .set({
        messageContent: validatedData.messageContent,
        isEdited: true,
        updatedAt: new Date(),
      })
      .where(eq(channelMessages.id, messageId))
      .returning()

    Logger.info({
      msg: "Channel message edited",
      messageId: updatedMessage.id,
      userId: currentUser.externalId,
    })

    // Get all channel members to send real-time notifications
    const members = await db
      .select({
        userId: channelMembers.userId,
        externalId: users.externalId,
      })
      .from(channelMembers)
      .innerJoin(users, eq(channelMembers.userId, users.id))
      .where(eq(channelMembers.channelId, message.channelId))

    // Send real-time notification to all channel members except the sender
    const memberExternalIds = members
      .filter((m) => m.userId !== currentUser.id)
      .map((m) => m.externalId)

    if (memberExternalIds.length > 0) {
      realtimeMessagingService.sendChannelMessageEdit(
        memberExternalIds,
        message.channelId,
        updatedMessage.id,
        updatedMessage.messageContent,
        updatedMessage.updatedAt,
      )
    }

    return c.json({
      success: true,
      message: {
        id: updatedMessage.id,
        messageContent: updatedMessage.messageContent,
        isEdited: updatedMessage.isEdited,
        updatedAt: updatedMessage.updatedAt,
      },
    })
  } catch (error) {
    Logger.error(error, "Error editing channel message")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to edit channel message" })
  }
}

// Delete channel message
export const DeleteChannelMessageApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = deleteChannelMessageSchema.parse(requestBody)
    const messageId = validatedData.messageId

    // Get current user
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get message and verify it belongs to workspace
    const message = await assertMessageBelongsToWorkspace(
      messageId,
      currentUser.workspaceId,
    )

    // Check if user is message sender or channel admin
    const isOwnMessage = message.sentByUserId === currentUser.id
    const userRole = await getUserChannelRole(message.channelId, currentUser.id)
    const hasDeletePermission = isOwnMessage || hasAdminPrivileges(userRole)

    if (!hasDeletePermission) {
      throw new HTTPException(403, {
        message: "Can only delete your own messages or must be channel admin",
      })
    }

    if (message.deletedAt) {
      throw new HTTPException(400, { message: "Message already deleted" })
    }

    // Soft delete
    await db
      .update(channelMessages)
      .set({
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(channelMessages.id, messageId))

    Logger.info({
      msg: "Channel message deleted",
      messageId: validatedData.messageId,
      userId: currentUser.externalId,
    })

    // Get all channel members to send real-time notifications
    const members = await db
      .select({
        userId: channelMembers.userId,
        externalId: users.externalId,
      })
      .from(channelMembers)
      .innerJoin(users, eq(channelMembers.userId, users.id))
      .where(eq(channelMembers.channelId, message.channelId))

    // Send real-time notification to all channel members except the sender
    const memberExternalIds = members
      .filter((m) => m.userId !== currentUser.id)
      .map((m) => m.externalId)

    if (memberExternalIds.length > 0) {
      realtimeMessagingService.sendChannelMessageDelete(
        memberExternalIds,
        message.channelId,
        validatedData.messageId,
      )
    }

    return c.json({
      success: true,
      message: "Message deleted successfully",
    })
  } catch (error) {
    Logger.error(error, "Error deleting channel message")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, {
      message: "Failed to delete channel message",
    })
  }
}

// Pin a message
export const PinMessageApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = pinMessageSchema.parse(requestBody)
    const messageId = validatedData.messageId

    // Get current user
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get message and verify it belongs to workspace
    const message = await assertMessageBelongsToWorkspace(
      messageId,
      currentUser.workspaceId,
    )

    if (message.deletedAt) {
      throw new HTTPException(400, { message: "Cannot pin deleted message" })
    }

    // Check if user is channel admin
    const userRole = await getUserChannelRole(message.channelId, currentUser.id)
    if (!hasAdminPrivileges(userRole)) {
      throw new HTTPException(403, {
        message: "Only channel admins can pin messages",
      })
    }

    if (message.isPinned) {
      throw new HTTPException(400, { message: "Message already pinned" })
    }

    // Pin message
    const [pinnedMessage] = await db
      .update(channelMessages)
      .set({
        isPinned: true,
        pinnedAt: new Date(),
        pinnedByUserId: currentUser.id,
        updatedAt: new Date(),
      })
      .where(eq(channelMessages.id, messageId))
      .returning()

    Logger.info({
      msg: "Message pinned",
      messageId: pinnedMessage.id,
      channelId: message.channelId,
      userId: currentUser.externalId,
    })

    return c.json({
      success: true,
      message: {
        id: pinnedMessage.id,
        isPinned: pinnedMessage.isPinned,
        pinnedAt: pinnedMessage.pinnedAt,
      },
    })
  } catch (error) {
    Logger.error(error, "Error pinning message")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to pin message" })
  }
}

// Unpin a message
export const UnpinMessageApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = unpinMessageSchema.parse(requestBody)
    const messageId = validatedData.messageId

    // Get current user
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get message and verify it belongs to workspace
    const message = await assertMessageBelongsToWorkspace(
      messageId,
      currentUser.workspaceId,
    )

    // Check if user is channel admin
    const userRole = await getUserChannelRole(message.channelId, currentUser.id)
    if (!hasAdminPrivileges(userRole)) {
      throw new HTTPException(403, {
        message: "Only channel admins can unpin messages",
      })
    }

    if (!message.isPinned) {
      throw new HTTPException(400, { message: "Message is not pinned" })
    }

    // Unpin message
    const [unpinnedMessage] = await db
      .update(channelMessages)
      .set({
        isPinned: false,
        pinnedAt: null,
        pinnedByUserId: null,
        updatedAt: new Date(),
      })
      .where(eq(channelMessages.id, messageId))
      .returning()

    Logger.info({
      msg: "Message unpinned",
      messageId: unpinnedMessage.id,
      channelId: message.channelId,
      userId: currentUser.externalId,
    })

    return c.json({
      success: true,
      message: {
        id: unpinnedMessage.id,
        isPinned: unpinnedMessage.isPinned,
      },
    })
  } catch (error) {
    Logger.error(error, "Error unpinning message")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to unpin message" })
  }
}

// Get pinned messages for a channel
export const GetPinnedMessagesApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate query parameters
    const validatedQuery = getPinnedMessagesSchema.parse({
      channelId: c.req.query("channelId"),
    })
    const channelId = validatedQuery.channelId

    // Get current user
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Verify channel belongs to workspace
    await assertChannelBelongsToWorkspace(channelId, currentUser.workspaceId)

    // Check if user is a member
    const isMember = await isChannelMember(channelId, currentUser.id)
    if (!isMember) {
      throw new HTTPException(403, {
        message: "Must be a channel member to view pinned messages",
      })
    }

    // Get pinned messages
    const pinnedMessages = await db
      .select({
        id: channelMessages.id,
        messageContent: channelMessages.messageContent,
        isEdited: channelMessages.isEdited,
        isPinned: channelMessages.isPinned,
        pinnedAt: channelMessages.pinnedAt,
        createdAt: channelMessages.createdAt,
        senderExternalId: users.externalId,
        senderName: users.name,
        senderEmail: users.email,
        senderPhotoLink: users.photoLink,
        pinnedByExternalId: sql<string>`pinned_by.external_id`,
        pinnedByName: sql<string>`pinned_by.name`,
      })
      .from(channelMessages)
      .innerJoin(users, eq(users.id, channelMessages.sentByUserId))
      .leftJoin(
        sql`users AS pinned_by`,
        sql`pinned_by.id = ${channelMessages.pinnedByUserId}`,
      )
      .where(
        and(
          eq(channelMessages.channelId, channelId),
          eq(channelMessages.isPinned, true),
          sql`${channelMessages.deletedAt} IS NULL`,
        ),
      )
      .orderBy(desc(channelMessages.pinnedAt))

    return c.json({
      success: true,
      pinnedMessages: pinnedMessages.map((msg) => ({
        id: msg.id,
        messageContent: msg.messageContent,
        isEdited: msg.isEdited,
        pinnedAt: msg.pinnedAt,
        createdAt: msg.createdAt,
        sender: {
          id: msg.senderExternalId,
          name: msg.senderName,
          email: msg.senderEmail,
          photoLink: msg.senderPhotoLink,
        },
        pinnedBy: {
          id: msg.pinnedByExternalId,
          name: msg.pinnedByName,
        },
      })),
    })
  } catch (error) {
    Logger.error(error, "Error getting pinned messages")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to get pinned messages" })
  }
}
