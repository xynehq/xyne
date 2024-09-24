import { and, eq } from "drizzle-orm";
import { db } from "./client";
import { users, workspaces } from "./schema";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { createId } from "@paralleldrive/cuid2";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { TxnOrClient } from "@/types";

export const getUserAndWorkspaceByEmail = async (trx: PgTransaction<any>, workspaceId: number, email: string) => {
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

export const getUserAndWorkspaceByOnlyEmail = async (trx: PgTransaction<any>, email: string) => {
    return await db
        .select({
            user: users,
            workspace: workspaces,
        })
        .from(users)
        .innerJoin(workspaces, eq(users.workspaceId, workspaces.id))  // Join workspaces on users.workspaceId
        .where(and(
            eq(users.email, email),  // Filter by user email
        )).limit(1)
}

// a util to fetch one whenever we do limit(1)
const onlyOne = (res, errorMsg: string) => {
    if (res.length) {
        return res[0]
    } else {
        throw new Error(errorMsg)
    }
}

// since email is unique across the users we don't need workspaceId
export const getUserByEmail = async (trx: TxnOrClient, email: string) => {
    return await db
        .select().from(users)
        .where(and(
            eq(users.email, email),
        )).limit(1)
}

export const createUser = async (trx: PgTransaction<any>,
    workspaceId: number,
    email: string,
    name: string,
    photoLink: string,
    accessToken: string,
    refreshToken: string,
    role: string,
    workspaceExternalId: string,
) => {
    const externalId = createId();
    return await trx.insert(users).values({
        externalId,
        workspaceId,
        email,
        name,
        photoLink,
        workspaceExternalId,
        googleAccessToken: accessToken,
        googleRefreshToken: refreshToken,
        lastLogin: new Date(),
        role,
    }).returning()
}