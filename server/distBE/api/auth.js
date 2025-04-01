import config from "../config.js"
import { db } from "../db/client.js"
import { getPublicUserAndWorkspaceByEmail } from "../db/user.js"
import {} from "../db/schema.js"
const { JwtPayloadKey } = config;
export const GetUserWorkspaceInfo = async (c) => {
    const { sub, workspaceId } = c.get(JwtPayloadKey);
    const email = sub;
    const userAndWorkspace = await getPublicUserAndWorkspaceByEmail(db, workspaceId, email);
    return c.json(userAndWorkspace);
};
