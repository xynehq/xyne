import { type TxnOrClient } from "@/types";
import { oauthProviders, type InsertOAuthProvider, type SelectOAuthProvider } from "./schema";
import { createId } from "@paralleldrive/cuid2";
import { Subsystem, type Apps } from "@/shared/types";
import { eq } from "drizzle-orm";
import { getLogger } from "../shared/logger";

const Logger = getLogger(Subsystem.Db).child({ module: 'oauth_provider' })

export const createOAuthProvider = async (trx: TxnOrClient, data: Omit<InsertOAuthProvider, "externalId">) => {
    const externalId = createId();
    const toInsert = { ...data, externalId: externalId }
    try {
        const inserted = await trx.insert(oauthProviders).values(
            toInsert,
        ).returning();
        Logger.info("Provider inserted successfully");
        return inserted[0]
    } catch (error) {
        Logger.error(`Error inserting provider:, ${error}`);
        throw new Error('Could not insert provider');
    }
}

export const getOAuthProvider = async (trx: TxnOrClient, app: Apps): Promise<SelectOAuthProvider> => {
    const res = await trx.select().from(oauthProviders).where(eq(oauthProviders.app, app)).limit(1)
    if (res.length) {
        return res[0]
    } else {
        throw new Error('Could not get the connector')
    }
} 