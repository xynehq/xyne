import { createId } from "@paralleldrive/cuid2";
import { workspaces } from "./schema";
import { db } from "./client";
import { eq } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";

export const mustGetWorkspaceByDomain = async (domain: string) => {
    const res = await db.select().from(workspaces).where(eq(workspaces.domain, domain)).limit(1)
    if (res.length) {
        return res[0]
    } else {
        throw new Error('Could not find workspaces by domain')
    }
}
export const getWorkspaceByDomain = async (domain: string) => {
    return db.select().from(workspaces).where(eq(workspaces.domain, domain)).limit(1)
}

export const getWorkspaceByEmail = async (trx: PgTransaction<any>, email: string) => {
    const res = await db.select().from(workspaces).where(eq(workspaces.createdBy, email)).limit(1)
    if (res.length) {
        return res[0]
    } else {
        throw new Error('Could not find workspaces by domain')
    }
}

export const createWorkspace = async (trx: PgTransaction<any>, createdBy: string, domain: string) => {
    const externalId = createId();
    // extract a default name out of the domain
    let name = domain.split('@')[0]
    name = name[0].toUpperCase() + name.slice(1)
    return trx.insert(workspaces).values({
        externalId,
        createdBy,
        domain,
        name,
    }).returning()
}