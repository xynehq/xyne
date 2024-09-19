import { createId } from "@paralleldrive/cuid2";
import { db } from "./client";
import { connectors } from "./schema";
import type { Apps, AuthType, ConnectorType } from "@/types";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";


export const insertConnector = async (
    trx: PgTransaction<any>,
    workspaceId: number,
    userId: number,
    name: string,
    type: ConnectorType,        // Use TypeScript enum for type safety
    authType: AuthType,          // Use TypeScript enum for authType
    app: Apps,                   // Use TypeScript enum for app
    config: Record<string, any>,
    credentials: string,
    subject?: string
) => {
    const externalId = createId();  // Generate unique external ID
    try {
        const inserted = await trx.insert(connectors).values({
            workspaceId,
            userId,
            externalId: externalId,    // Unique external ID for the connection
            name: name,                // Name of the connection
            type: type,                // Type of connection from the enum
            authType: authType,        // Authentication type from the enum
            app: app,                  // App type from the enum
            config: config,            // JSON configuration for the connection
            credentials: credentials,  // Encrypted credentials
            subject,
            // createdAt: new Date(),     // Set creation date
            // updatedAt: new Date(),     // Set update date
        }).returning();
        console.log("Connection inserted successfully");
        return inserted[0]?.id
    } catch (error) {
        console.error("Error inserting connection:", error);
        throw new Error('Could not insert connection');
    }
};

export const getConnector = async (connectionId: number) => {
    const res = await db.select().from(connectors).where(eq(connectors.id, connectionId)).limit(1)
    if (res.length) {
        return res[0]
    } else {
        throw new Error('Could not get the connector')
    }
}