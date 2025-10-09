// Manual webhook registration script
import { webhookRegistry } from "./services/webhookRegistry"

async function registerTestWebhook() {
  try {
    console.log('🔧 Manually registering webhook...')
    
    const webhookConfig = {
      webhookUrl: "http://localhost:3000/webhook/test",
      httpMethod: "POST" as const,
      path: "/test",
      authentication: "none" as const,
      responseMode: "immediately" as const,
      headers: {},
      queryParams: {},
      options: {}
    }

    await webhookRegistry.registerWebhook(
      "/test",
      "manual-template-id",
      "manual-tool-id", 
      webhookConfig
    )

    console.log('✅ Webhook registered successfully!')
    console.log('🔗 Test with: curl -X POST "http://localhost:3000/webhook/test" -H "Content-Type: application/json" -d \'{"test": true}\'')
    
    // List all webhooks
    const webhooks = webhookRegistry.getAllWebhooks()
    console.log('📋 All registered webhooks:', webhooks)
    
  } catch (error) {
    console.error('❌ Registration failed:', error)
  }
}

registerTestWebhook()