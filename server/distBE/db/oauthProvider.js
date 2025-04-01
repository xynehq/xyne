import { Subsystem } from "../types.js"
import { oauthProviders } from "./schema.js"
import { createId } from "@paralleldrive/cuid2";
import {} from "../shared/types.js"
import { and, eq } from "drizzle-orm";
import { getLogger } from "../logger/index.js";
const Logger = getLogger(Subsystem.Db).child({ module: "oauth_provider" });
export const createOAuthProvider = async (trx, data) => {
    const externalId = createId();
    const toInsert = { ...data, externalId: externalId };
    try {
        const inserted = await trx
            .insert(oauthProviders)
            .values(toInsert)
            .returning();
        Logger.info("Provider inserted successfully");
        return inserted[0];
    }
    catch (error) {
        Logger.error(error, `Error inserting provider:, ${error} : ${error.stack}`);
        throw new Error("Could not insert provider");
    }
};
export const getOAuthProvider = async (trx, userId, app) => {
    const res = await trx
        .select()
        .from(oauthProviders)
        .where(and(eq(oauthProviders.app, app), eq(oauthProviders.userId, userId)))
        .limit(1);
    if (res.length) {
        return res[0];
    }
    else {
        throw new Error("Could not get the connector");
    }
};
export const getOAuthProviderByConnectorId = async (trx, connectorId) => {
    const res = await trx
        .select()
        .from(oauthProviders)
        .where(eq(oauthProviders.connectorId, connectorId))
        .limit(1);
    if (res.length) {
        return res;
    }
    else {
        throw new Error("Could not get the provider");
    }
};
