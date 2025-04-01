import { createId } from "@paralleldrive/cuid2";
import { workspaces } from "./schema.js"
import { db } from "./client.js";
import { eq } from "drizzle-orm";
export const mustGetWorkspaceByDomain = async (domain) => {
    const res = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.domain, domain))
        .limit(1);
    if (res.length) {
        return res[0];
    }
    else {
        throw new Error("Could not find workspaces by domain");
    }
};
export const getWorkspaceByDomain = async (domain) => {
    return db
        .select()
        .from(workspaces)
        .where(eq(workspaces.domain, domain))
        .limit(1);
};
export const getWorkspaceById = async (trx, id) => {
    const res = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, id))
        .limit(1);
    if (res.length) {
        return res[0];
    }
    else {
        throw new Error("Could not find workspaces by id");
    }
};
export const getWorkspaceByCreatedBy = async (trx, email) => {
    const res = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.createdBy, email))
        .limit(1);
    if (res.length) {
        return res[0];
    }
    else {
        throw new Error("Could not find workspaces by domain");
    }
};
export const createWorkspace = async (trx, createdBy, domain) => {
    const externalId = createId();
    // extract a default name out of the domain
    let name = domain.split("@")[0];
    name = name[0].toUpperCase() + name.slice(1);
    return trx
        .insert(workspaces)
        .values({
        externalId,
        createdBy,
        domain,
        name,
    })
        .returning();
};
