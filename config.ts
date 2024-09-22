
let vespaBaseHost = "0.0.0.0"
let postgresBaseHost = "0.0.0.0"
if (Bun.env.NODE_ENV === 'production') {
    postgresBaseHost = process.env.DATABASE_HOST!
    vespaBaseHost = process.env.VESPA_HOST!
}

export default {
    page: 8,
    JwtPayloadKey: 'jwtPayload',
    vespaBaseHost,
    postgresBaseHost
}