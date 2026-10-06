/**
 * Spyglass Language Server Offline Preload
 * 
 * Intercepts `globalThis.fetch` to enable seamless offline operation within sandboxed environments.
 * When Spyglass attempts conditional HTTP requests (with If-None-Match or If-Modified-Since),
 * this interceptor returns HTTP 304 Not Modified, prompting Spyglass to instantly reuse
 * its local disk cache in `~/.cache/spyglassmc-nodejs/http/` without waiting for network timeouts.
 */

const origFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const headers = init?.headers || (input?.headers ? Object.fromEntries(input.headers.entries()) : {});
  const isConditional = Boolean(headers['if-none-match'] || headers['if-modified-since']);

  // If conditional validation headers exist, immediately return 304 if offline
  if (isConditional) {
    try {
      if (typeof origFetch === 'function') {
        return await origFetch(input, init);
      }
    } catch {
      return new Response(null, { status: 304, statusText: 'Not Modified' });
    }
  }

  try {
    return await origFetch(input, init);
  } catch (err) {
    if (isConditional) {
      return new Response(null, { status: 304, statusText: 'Not Modified' });
    }
    throw err;
  }
};
