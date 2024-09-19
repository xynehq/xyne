import { and, eq } from "drizzle-orm";
import { db } from "./client";
import { users, workspaces } from "./schema";

export const getUserWithWorkspaceByEmail = async (workspaceId: number, email: string) => {
    return await db
        .select({
            user: users,
            workspace: workspaces,
        })
        .from(users)
        .innerJoin(workspaces, eq(users.workspaceId, workspaces.id))  // Join workspaces on users.workspaceId
        .where(and(
            eq(users.email, email),  // Filter by user email
            eq(users.workspaceId, workspaceId),  // Filter by workspaceId
        )).limit(1)
}