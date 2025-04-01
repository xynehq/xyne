export const ProxyUrl = async (c) => {
    const targetUrl = decodeURIComponent(c.req.param("url"));
    const response = await fetch(targetUrl);
    if (!response.ok) {
        return c.text("Failed to fetch the image.", 502);
    }
    // Stream the response body directly to the client
    return new Response(response.body, {
        status: response.status,
        headers: {
            "Content-Type": response.headers.get("Content-Type") || "application/octet-stream",
            "Cache-Control": "public, max-age=86400", // Cache for 1 day
        },
    });
};
