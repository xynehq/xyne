import { createId } from "@paralleldrive/cuid2";
import { db } from "./client";
import { users, workspaces } from "./schema";
import { getUserAndWorkspaceByEmail } from "./user";
import { ServerLogger } from "@/logger";
import { LOGGERTYPES } from "@/types";

const Logger =  new ServerLogger(LOGGERTYPES.db)

const seed = async () => {
    Logger.info('here')
    try {
        const workspaceExternalId = createId();
        // Start a transaction
        await db.transaction(async (tx) => {
            // Insert a new workspace
            const [workspace] = await tx
                .insert(workspaces)
                .values({
                    name: 'Xyne',
                    domain: 'xynehq.com',
                    externalId: workspaceExternalId, // Set externalId explicitly
                    // createdAt, updatedAt, deletedAt are set by defaults
                })
                .returning();

                Logger.info(`Inserted Workspace:, ${workspace}`);

            // Insert a new user associated with the workspace
            const [user] = await tx
                .insert(users)
                .values({
                    workspaceId: workspace.id,
                    email: 'saheb@xynehq.com',
                    name: 'saheb jot',
                    externalId: workspaceExternalId, // Set externalId explicitly
                    // role defaults to 'user'
                    // createdAt, updatedAt, deletedAt are set by defaults
                })
                .returning();

                Logger.info(`Inserted User:', ${user}`);
        });

        Logger.info('Seeding completed successfully.');
    } catch (error) {
        Logger.error(`Error during seeding:, ${error}`);
    }

}

await seed()
process.exit(0)