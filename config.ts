
let vespaBaseHost = "0.0.0.0"
let postgresBaseHost = "0.0.0.0"
let port = 3000
if (Bun.env.NODE_ENV === 'production') {
    postgresBaseHost = process.env.DATABASE_HOST!
    vespaBaseHost = process.env.VESPA_HOST!
    port = 80
}

export default {
    page: 8,
    JwtPayloadKey: 'jwtPayload',
    vespaBaseHost,
    postgresBaseHost,
    port
}