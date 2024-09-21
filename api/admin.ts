import type { Context } from "hono"
import { HTTPException } from 'hono/http-exception'


import { db } from '@/db/client'
import { users, workspaces } from "@/db/schema"
import { getUserAndWorkspaceByEmail, getUserByEmail } from "@/db/user"
import { getConnector, getConnectors, insertConnector } from "@/db/connector"
import { AuthType, ConnectorType, type SaaSJob } from "@/types"
import { boss, SaaSQueue } from "@/queue"
import config from "@/config"
const { JwtPayloadKey } = config

export const GetConnectors = async (c: Context) => {
    const { workspaceId } = c.get(JwtPayloadKey)
    const connectors = await getConnectors(workspaceId)
    return c.json(connectors)
}

export const AddServiceConnection = async (c: Context) => {
    const { sub, workspaceId } = c.get(JwtPayloadKey)
    const email = sub
    const userRes = await getUserByEmail(db, email)
    if (!userRes || !userRes.length) {
        throw new Error('Could not get user')
    }
    const [user] = userRes

    // Start a transaction
    return await db.transaction(async (trx) => {
        try {
            const form = c.req.valid('form')
            const data = await form['service-key'].text()
            const subject = form['email']
            const app = form['app']

            // Insert the connection within the transaction
            const connector = await insertConnector(
                trx,  // Pass the transaction object
                user.workspaceId,
                user.id,
                user.workspaceExternalId,
                `${app}-${ConnectorType.SaaS}-${AuthType.ServiceAccount}`,
                ConnectorType.SaaS,
                AuthType.ServiceAccount,
                app,
                {},
                data,
                subject
            )

            const SaasJobPayload: SaaSJob = {
                connectorId: connector.id,
                workspaceId: user.workspaceId,
                userId: user.id,
                app,
                externalId: connector.externalId
            }
            // Enqueue the background job within the same transaction
            const jobId = await boss.send(SaaSQueue, SaasJobPayload)

            console.log(`Job ${jobId} enqueued for connection ${connector.id}`)

            // Commit the transaction if everything is successful
            return c.json({ success: true, message: 'Connection created, job enqueued', id: connector.externalId })

        } catch (error) {
            console.error("Error:", error)
            // Rollback the transaction in case of any error
            throw new HTTPException(500, { message: 'Error creating connection or enqueuing job' })
        }
    })
}