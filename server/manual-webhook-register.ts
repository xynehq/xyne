import { webhookRegistry } from "./services/webhookRegistry"

// Manually register the /test webhook
async function registerTestWebhook() {
  console.log('🔧 Manually registering /test webhook...')
  
  try {
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
      "manual-template",
      "manual-tool",
      webhookConfig
    )

    console.log('✅ Webhook registered successfully!')
    
    // List all webhooks
    const webhooks = webhookRegistry.getAllWebhooks()
    console.log('📋 Registered webhooks:', webhooks.map(w => w.path))
    
    console.log('\n🔗 Test with:')
    console.log('curl -X POST "http://localhost:3000/webhook/test" -H "Content-Type: application/json" -d \'{"test": true}\'')
    
  } catch (error) {
    console.error('❌ Failed to register webhook:', error)
  }
}

registerTestWebhook()