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
if (process.env.AwsAccessKey && process.env.AwsSecretKey) {
  AwsAccessKey = process.env.AwsAccessKey
  AwsSecretKey = process.env.AwsSecretKey
  bedrockSupport = true
}

export default {
  page: 8,
  JwtPayloadKey: "jwtPayload",
  vespaBaseHost,
  postgresBaseHost,
  port,
  host,
  bedrockSupport,
  AwsAccessKey,
  AwsSecretKey,
}
