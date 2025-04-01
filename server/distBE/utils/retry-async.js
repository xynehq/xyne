/**
 * Retries async operation returned from "func" callback, according to "options".
 */
export function retryAsync(func, options) {
    const start = Date.now();
    let index = 0, e;
    let { retry = Number.POSITIVE_INFINITY, delay = -1, error } = options ?? {};
    const s = () => ({ index, duration: Date.now() - start, error: e });
    const c = () => func(s()).catch((err) => {
        e = err;
        typeof error === "function" && error(s());
        if ((typeof retry === "function" ? (retry(s()) ? 1 : 0) : retry--) <= 0) {
            return Promise.reject(e);
        }
        const d = typeof delay === "function" ? delay(s()) : delay;
        index++;
        return d >= 0 ? new Promise((a) => setTimeout(a, d)).then(c) : c();
    });
    return c();
}
