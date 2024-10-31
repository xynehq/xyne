let vespaBaseHost = "0.0.0.0"
let postgresBaseHost = "0.0.0.0"
let port = 3000
let host = "http://localhost:3000"
if (process.env.NODE_ENV === "production") {
  postgresBaseHost = process.env.DATABASE_HOST!
  vespaBaseHost = process.env.VESPA_HOST!
  port = 80
  host = process.env.HOST!
}

let bedrockSupport = false
let AwsAccessKey = ""
let AwsSecretKey = ""
let OpenAIKey = ""
if (process.env["AWS_ACCESS_KEY"] && process.env["AWS_SECRET_KEY"]) {
  AwsAccessKey = process.env["AWS_ACCESS_KEY"]
  AwsSecretKey = process.env["AWS_SECRET_KEY"]
  bedrockSupport = true
}

if (process.env["OPENAI_API_KEY"]) {
  OpenAIKey = process.env["OPENAI_API_KEY"]
}

export default {
  // default page size for regular search
  page: 8,
  // default page size for default search over answers
  answerPage: 12,
  // the max token length of input tokens before
  // we clean up using the metadata
  maxTokenBeforeMetadataCleanup: 3000,
  JwtPayloadKey: "jwtPayload",
  vespaBaseHost,
  postgresBaseHost,
  port,
  host,
  bedrockSupport,
  AwsAccessKey,
  AwsSecretKey,
  OpenAIKey,
}
