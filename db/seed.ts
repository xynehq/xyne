import { createId } from "@paralleldrive/cuid2";
import { db } from "./client";
import { users, workspaces } from "./schema";
import { getUserWithWorkspaceByEmail } from "./user";

const seed = async () => {
    console.log('here')
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

            console.log('Inserted Workspace:', workspace);

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

            console.log('Inserted User:', user);
        });

        console.log('Seeding completed successfully.');
    } catch (error) {
        console.error('Error during seeding:', error);
    }

}

await seed()
process.exit(0)